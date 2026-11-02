/**
 * EmDash AI Helper — generate a meta description on publish when the editor
 * did not write one.
 *
 * Lifecycle semantics (EmDash 1.4.0):
 *
 * - `content:afterPublish` is the only lifecycle hook that generates. It runs
 *   after the publish transaction has committed and is dispatched as deferred
 *   work, so a generation failure can never fail or roll back a publish. The
 *   entry stays live; the failure is recorded as a diagnostic an administrator
 *   can read.
 * - The generated text is saved once. The canonical target is the entry's SEO
 *   panel via `ctx.content.update(collection, id, { seo })`; EmDash treats an
 *   SEO-only write as a SEO-table write, so it does not run content save hooks
 *   and the plugin cannot re-trigger itself. On EmDash 1.4.0 sandbox runners
 *   that write rejects with `UNKNOWN_FIELD` (the sandbox bridge does not yet
 *   split `seo` from field data), so the plugin keeps a fallback copy in its
 *   own storage and contributes it through the `page:metadata` hook instead.
 *   When the SEO-panel write succeeds the fallback copy is removed so the
 *   panel stays the single source of truth.
 * - `page:metadata` only ever reads plugin storage; it never calls the AI
 *   endpoint. It contributes a `<meta name="description">` tag only when the
 *   page carries no description of its own, so site-provided and
 *   editor-authored descriptions always win.
 * - Registering `content:beforeSave` would generate on every draft save, so it
 *   is deliberately not used.
 * - Nothing is generated while a public page is served.
 *
 * Data flow: title and body text of the published entry go to the configured
 * OpenAI-compatible endpoint over HTTPS, with the admin's token in an
 * `Authorization` header. The token is stored encrypted by EmDash, never
 * written to storage, logs, routes, or diagnostics.
 */

import type { SandboxedPlugin } from "emdash/plugin";

import { describeConfig, resolveConfig, type EndpointConfig } from "./lib/config.js";
import { buildPrompt, describeOutput } from "./lib/describe.js";
import { requestDescription, safeFailureText } from "./lib/openai.js";
import { extractSourceText } from "./lib/text.js";

type GenerationStatus = "running" | "generated" | "skipped" | "failed";

interface GenerationRecord {
	dedupeKey: string;
	collection: string;
	contentId: string;
	sourceHash: string;
	status: GenerationStatus;
	outcome?: string;
	attempts: number;
	model?: string;
	endpointHost?: string;
	descriptionChars?: number;
	errorCode?: string;
	updatedAt: string;
}

/**
 * Fallback description served by the `page:metadata` hook when the canonical
 * SEO-panel write is unavailable on the current runner.
 */
interface DescriptionRecord {
	collection: string;
	contentId: string;
	description: string;
	updatedAt: string;
}

const PUBLISH_HOOK_TIMEOUT_MS = 15_000;

/**
 * The subset of EmDash's `StorageCollection` this plugin uses, typed for the
 * `generations` records. `emdash/plugin` does not re-export the storage
 * interface, so the shape is declared locally and cast at the access site.
 */
interface GenerationStore {
	getVersioned(
		id: string,
	): Promise<{ value: GenerationRecord; revision: string } | null>;
	compareAndSet(
		id: string,
		expectedRevision: string | null,
		data: GenerationRecord,
	): Promise<{ applied: true; revision: string } | { applied: false }>;
	updateIf(
		id: string,
		args: { where: Record<string, unknown>; set?: Partial<GenerationRecord> },
	): Promise<{ applied: true; data: GenerationRecord } | { applied: false }>;
	query(options?: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
	}): Promise<{
		items: Array<{ id: string; data: GenerationRecord }>;
		hasMore: boolean;
	}>;
}

interface AuditStore {
	put(id: string, data: Record<string, unknown>): Promise<void>;
}

interface DescriptionStore {
	get(id: string): Promise<DescriptionRecord | null>;
	put(id: string, data: DescriptionRecord): Promise<void>;
	delete(id: string): Promise<boolean>;
}

function hasText(value: unknown): boolean {
	return typeof value === "string" && value.trim() !== "";
}

async function sha256Hex(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Decide whether a publish of this content hash should call the endpoint.
 *
 * `reuse` is the answer for the common publish-retry case: the entry has
 * already been described, is being described right now, or has exhausted its
 * retry budget, so no request is sent and no cost is incurred.
 */
function shouldRequest(
	record: GenerationRecord | undefined,
	config: EndpointConfig,
	nowMs: number,
): boolean {
	if (!record) return true;
	if (record.status !== "failed") return false;
	if (record.attempts >= config.maxAttempts) return false;
	const lastAttempt = Date.parse(record.updatedAt);
	if (!Number.isFinite(lastAttempt)) return true;
	return nowMs - lastAttempt >= config.retryCooldownMs;
}

const plugin: SandboxedPlugin = {
	hooks: {
		"content:afterPublish": {
			priority: 100,
			timeout: PUBLISH_HOOK_TIMEOUT_MS,
			errorPolicy: "continue",
			handler: async (event, ctx) => {
				const content = event.content as Record<string, unknown>;
				const contentId = typeof content.id === "string" ? content.id : undefined;
				const collection = event.collection;
				if (!contentId) return;

				const store = ctx.storage.generations as unknown as GenerationStore;
				const audit = ctx.storage.audit as unknown as AuditStore;
				const descriptions = ctx.storage.descriptions as unknown as DescriptionStore;
				const note = async (
					status: GenerationStatus,
					outcome: string,
					errorCode?: string,
				): Promise<void> => {
					await audit.put(`note:${collection}:${contentId}:${outcome}`, {
						status,
						outcome,
						errorCode,
						collection,
						contentId,
						at: new Date().toISOString(),
					});
				};

				try {
					const resolved = await resolveConfig(ctx.settings);
					if (!resolved.ok) {
						await note("skipped", `config:${resolved.issue}`);
						ctx.log.warn("Meta description skipped: configuration incomplete", {
							collection,
							contentId,
							issue: resolved.issue,
						});
						return;
					}
					const config = resolved.config;

					const entry = await ctx.content?.get(collection, contentId);
					if (!entry) return;

					// Collections without the core SEO panel have nowhere to store a
					// meta description; say so once per entry instead of looping.
					if (entry.seo === undefined) {
						await note("skipped", "seo-disabled");
						ctx.log.info("Meta description skipped: SEO panel is disabled for this collection", {
							collection,
							contentId,
						});
						return;
					}

					// An editor-authored description always wins.
					if (hasText(entry.seo.description)) {
						await note("skipped", "manual-description");
						return;
					}

					const source = extractSourceText(entry.data ?? {});
					if (source.charCount === 0) {
						await note("skipped", "empty-source");
						ctx.log.info("Meta description skipped: entry has no text to summarise", {
							collection,
							contentId,
						});
						return;
					}

					// One in-flight generation per entry, so two publishes of the same
					// entry cannot overwrite each other's description.
					const guardKey = `guard:${collection}:${contentId}`;
					if (await ctx.kv.getVersioned(guardKey)) return;
					const guard = await ctx.kv.compareAndSet(guardKey, null, {
						at: new Date().toISOString(),
					});
					if (!guard.applied) return;

					try {
						const sourceHash = await sha256Hex(
							[
								collection,
								contentId,
								source.title,
								source.body,
								config.model,
								config.minLength,
								config.maxLength,
							].join("\u0000"),
						);
						const recordId = sourceHash;

						const existing = await store.getVersioned(recordId);
						if (!shouldRequest(existing?.value, config, Date.now())) {
							return;
						}
						const attempts = (existing?.value.attempts ?? 0) + 1;
						const claim = await store.compareAndSet(recordId, existing?.revision ?? null, {
							dedupeKey: `${collection}:${contentId}:${sourceHash}`,
							collection,
							contentId,
							sourceHash,
							status: "running",
							attempts,
							model: config.model,
							endpointHost: config.host,
							updatedAt: new Date().toISOString(),
						} satisfies GenerationRecord);
						if (!claim.applied) return;

						const prompt = buildPrompt(
							source,
							entry.locale ?? ctx.site.locale ?? "en",
							config.minLength,
							config.maxLength,
						);
						const result = await requestDescription(ctx.http!, config, prompt);

						if (!result.ok) {
							const errorCode = safeFailureText(result, config.apiKey);
							await store.updateIf(recordId, {
								where: { status: "running" },
								set: { status: "failed", errorCode, updatedAt: new Date().toISOString() },
							});
							await note("failed", "endpoint", errorCode);
							ctx.log.warn("Meta description generation failed", {
								collection,
								contentId,
								endpointHost: config.host,
								errorCode,
								attempt: attempts,
							});
							return;
						}

						const validated = describeOutput(result.text, config.minLength, config.maxLength);
						if (!validated.ok) {
							await store.updateIf(recordId, {
								where: { status: "running" },
								set: {
									status: "failed",
									errorCode: `INVALID_OUTPUT:${validated.issue}`,
									updatedAt: new Date().toISOString(),
								},
							});
							await note("failed", "invalid-output", validated.issue);
							ctx.log.warn("Meta description rejected by validation", {
								collection,
								contentId,
								issue: validated.issue,
								finishReason: result.finishReason,
							});
							return;
						}

						// Re-read before writing: an editor may have typed a description
						// while the request was in flight, and that text must win.
						const fresh = await ctx.content?.get(collection, contentId);
						if (fresh && hasText(fresh.seo?.description)) {
							await store.updateIf(recordId, {
								where: { status: "running" },
								set: {
									status: "skipped",
									outcome: "manual-description",
									updatedAt: new Date().toISOString(),
								},
							});
							return;
						}

						// Canonical target: the entry's SEO panel. On 1.4.0 sandbox
						// runners this write can reject (the bridge does not yet split
						// `seo` from field data); the generated text then lives in the
						// plugin's own storage and is served through `page:metadata`.
						let panelWriteFailed = false;
						const contentAccess = ctx.content!;
						if (typeof contentAccess.update !== "function") {
							panelWriteFailed = true;
						} else {
							try {
								await contentAccess.update(collection, contentId, {
									seo: { description: validated.value },
								});
								// The panel is the single source of truth once it carries
								// the description: drop any stale fallback copy.
								await descriptions.delete(`${collection}:${contentId}`);
							} catch {
								panelWriteFailed = true;
							}
						}

						if (panelWriteFailed) {
							await descriptions.put(`${collection}:${contentId}`, {
								collection,
								contentId,
								description: validated.value,
								updatedAt: new Date().toISOString(),
							});
						}

						await store.updateIf(recordId, {
							where: { status: "running" },
							set: {
								status: "generated",
								outcome: panelWriteFailed ? "generated:fallback" : "generated",
								descriptionChars: validated.value.length,
								errorCode: undefined,
								updatedAt: new Date().toISOString(),
							},
						});
						await note("generated", panelWriteFailed ? "seo-write-failed" : "generated");
						ctx.log.info(
							panelWriteFailed
								? "Meta description generated (SEO panel unavailable; served by plugin)"
								: "Meta description generated",
							{
								collection,
								contentId,
								characters: validated.value.length,
								model: config.model,
							},
						);
					} finally {
						await ctx.kv.compareAndDelete(guardKey, guard.revision);
					}
				} catch (error) {
					// Never propagate: a broken endpoint must not disturb publishing.
					ctx.log.error("Meta description generation raised unexpectedly", {
						collection,
						contentId,
						message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
					});
				}
			},
		},

		/**
		 * Serves the generated description when the SEO-panel write was not
		 * possible on this runner. Reads plugin storage only — the AI endpoint is
		 * never called while a public page is rendered. EmDash deduplicates
		 * first-wins, so a description the site or the SEO panel already
		 * provides always takes precedence over this contribution.
		 */
		"page:metadata": async (event, ctx) => {
			const page = event.page;
			if (page.kind !== "content" || !page.content) return null;
			if (page.description != null) return null;

			const descriptions = ctx.storage.descriptions as unknown as DescriptionStore;
			const record = await descriptions.get(`${page.content.collection}:${page.content.id}`);
			if (!record || !hasText(record.description)) return null;

			return [{ kind: "meta", name: "description", content: record.description }];
		},
	},

	routes: {
		/**
		 * Setup diagnostics for administrators: the active endpoint summary and
		 * the most recent outcomes. Never includes the token, the request body,
		 * the generated text, or any endpoint response body.
		 */
		diagnostics: {
			methods: ["GET"],
			request: { body: "none" },
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => {
				const resolved = await resolveConfig(ctx.settings);
				const recent = await (
					ctx.storage.generations as unknown as GenerationStore
				).query({ orderBy: { updatedAt: "desc" }, limit: 20 });

				// Optional entry readback: what the plugin sees for one entry.
				const input = routeCtx.input as Record<string, string | string[]>;
				const queryCollection = typeof input.collection === "string" ? input.collection : null;
				const queryId = typeof input.id === "string" ? input.id : null;
				let entry: Record<string, unknown> | null = null;
				if (queryCollection && queryId && ctx.content) {
					const item = await ctx.content.get(queryCollection, queryId);
					if (item) {
						entry = {
							collection: queryCollection,
							id: queryId,
							status: item.status,
							seoPanelEnabled: item.seo !== undefined,
							// Panel text only — the fallback copy is intentionally not
							// exposed here; it belongs to the page:metadata channel.
							seoDescription: item.seo?.description ?? null,
						};
					}
				}

				return {
					ok: true,
					configured: resolved.ok,
					issue: resolved.ok ? null : resolved.issue,
					config: resolved.ok ? describeConfig(resolved.config) : null,
					entry,
					recent: recent.items.map((item) => ({
						collection: item.data.collection,
						contentId: item.data.contentId,
						status: item.data.status,
						outcome: item.data.outcome ?? null,
						attempts: item.data.attempts,
						errorCode: item.data.errorCode ?? null,
						updatedAt: item.data.updatedAt,
					})),
				};
			},
		},

		/**
		 * Send one fixed probe request to the configured endpoint so an
		 * administrator can verify connectivity and the token without sending
		 * any site content.
		 */
		"test-endpoint": {
			methods: ["POST"],
			request: { body: "none" },
			permission: "plugins:manage",
			handler: async (_routeCtx, ctx) => {
				const resolved = await resolveConfig(ctx.settings);
				if (!resolved.ok) return { ok: false, issue: resolved.issue };
				const config = resolved.config;
				const result = await requestDescription(ctx.http!, config, {
					system: "Reply with the single word OK.",
					user: "Connectivity check.",
				});
				if (result.ok) {
					return { ok: true, host: config.host, model: config.model };
				}
				return {
					ok: false,
					failure: result.failure,
					status: result.status ?? null,
					host: config.host,
				};
			},
		},
	},
};

export default plugin;
