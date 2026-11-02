import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createPluginRuntimeTestHost,
	type PluginRuntimeTestHost,
} from "@emdash-cms/plugin-test";

let host: PluginRuntimeTestHost | undefined;

const TOKEN = "sk-test-1234567890abcdef";
const ENDPOINT = "https://api.openai.com/v1/chat/completions";

function completion(text: string, finishReason = "stop"): Response {
	return new Response(
		JSON.stringify({
			id: "chatcmpl-test",
			object: "chat.completion",
			created: 0,
			model: "gpt-4o-mini",
			choices: [{ index: 0, finish_reason: finishReason, message: { role: "assistant", content: text } }],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

beforeEach(async () => {
	host = await createPluginRuntimeTestHost({
		site: { name: "AI Helper Test", url: "https://plugin.test", locale: "en" },
	});
	await host.fixtures.collection({
		slug: "articles",
		label: "Articles",
		hasSeo: true,
		fields: [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "body", label: "Body", type: "text" },
		],
	});
});

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

async function configureEndpoint(): Promise<void> {
	await host!.actions.plugin.updateSettings({
		enabled: true,
		endpoint: ENDPOINT,
		model: "gpt-4o-mini",
		apiKey: TOKEN,
		minLength: 70,
		maxLength: 160,
		timeoutMs: 8000,
		maxAttempts: 3,
	});
}

interface PublishedArticle {
	id: string;
}

async function createArticle(
	data: Record<string, unknown>,
	seo?: { description?: string | null },
): Promise<string> {
	const created = await host!.actions.content.create("articles", { data });
	if (!created.success || !created.data) {
		const failure = created as { error?: unknown };
		throw new Error(`create failed: ${JSON.stringify(failure.error ?? failure)}`);
	}
	const id = created.data.item.id;
	if (seo) {
		const updated = await host!.actions.content.update("articles", id, { seo });
		if (!updated.success) {
			throw new Error("seo update failed");
		}
	}
	return id;
}

async function publishArticle(id: string): Promise<void> {
	const publish = await host!.actions.content.publish("articles", id);
	if (!publish.success) {
		const failure = publish as { error?: unknown };
		throw new Error(`publish failed: ${JSON.stringify(failure.error ?? failure)}`);
	}
	await host!.waitForDeferredTasks();
}

/** Read the plugin's own view of an entry through its diagnostics route. */
async function pluginView(collection: string, id: string): Promise<{
	status: string;
	seoPanelEnabled: boolean;
	seoDescription: string | null;
} | null> {
	const diagnostics = (await host!.transport.invokeRoute("diagnostics", {
		collection,
		id,
	})) as { entry: Record<string, unknown> | null };
	const entry = diagnostics.entry;
	if (!entry) return null;
	return {
		status: entry.status as string,
		seoPanelEnabled: entry.seoPanelEnabled as boolean,
		seoDescription: (entry.seoDescription as string | null) ?? null,
	};
}

/** Read the plugin's fallback description record. */
async function fallbackDescription(collection: string, id: string): Promise<string | null> {
	const record = await host!.inspect.storage.get<{ description?: string }>(
		"descriptions",
		`${collection}:${id}`,
	);
	return record?.description ?? null;
}

/** Read the newest audit note outcome for an entry. */
async function latestOutcome(id: string): Promise<string | null> {
	const audit = await host!.inspect.storage.list<{ contentId: string; outcome: string }>("audit");
	const notes = audit.filter((entry) => entry.data.contentId === id);
	return notes.length > 0 ? notes[notes.length - 1]!.data.outcome : null;
}

describe("publish lifecycle: description generation", () => {
	it("generates and stores a description when the editor did not write one", async () => {
		await configureEndpoint();
		await host!.http.respond(ENDPOINT, completion("A".repeat(100)));
		const id = await createArticle({
			title: "A test article",
			body: "Long body text about testing.".repeat(20),
		});
		await publishArticle(id);

		// On the 1.4.0 sandbox runner the SEO-panel write falls back to plugin
		// storage; either channel must end up with the generated text.
		const view = await pluginView("articles", id);
		const fallback = await fallbackDescription("articles", id);
		const generated = view?.seoDescription ?? fallback;
		expect(generated).toBe("A".repeat(100));

		// Exactly one outbound request, carrying the bearer token in the header.
		const requests = host!.http.requests();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(ENDPOINT);
		expect(requests[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
		const body = JSON.parse(new TextDecoder().decode(requests[0]!.body)) as {
			model: string;
			messages: Array<{ role: string; content: string }>;
		};
		expect(body.model).toBe("gpt-4o-mini");
		const userMessage = body.messages.find((message) => message.role === "user");
		expect(userMessage?.content).toContain("Long body text about testing");
	});

	it("preserves a manually authored description and never calls the endpoint", async () => {
		await configureEndpoint();
		const id = await createArticle(
			{ title: "Manual article", body: "Body text.".repeat(30) },
			{ description: "Editor wrote this description." },
		);
		await publishArticle(id);

		expect(host!.http.requests()).toHaveLength(0);
		const view = await pluginView("articles", id);
		expect(view?.seoDescription).toBe("Editor wrote this description.");
		expect(await latestOutcome(id)).toBe("manual-description");
	});

	it("skips entries without any prose instead of calling the endpoint", async () => {
		await configureEndpoint();
		await host!.fixtures.collection({
			slug: "stats",
			label: "Stats",
			hasSeo: true,
			fields: [{ slug: "views", label: "Views", type: "number" }],
		});
		const created = await host!.actions.content.create("stats", {
			data: { views: 42 },
			slug: "no-prose-entry",
		});
		if (!created.success || !created.data) {
			const failure = created as { error?: unknown };
			throw new Error(`create failed: ${JSON.stringify(failure.error ?? failure)}`);
		}
		const id = created.data.item.id;
		const publish = await host!.actions.content.publish("stats", id);
		if (!publish.success) {
			const failure = publish as { error?: unknown };
			throw new Error(`publish failed: ${JSON.stringify(failure.error ?? failure)}`);
		}
		await host!.waitForDeferredTasks();

		expect(host!.http.requests()).toHaveLength(0);
		expect(await latestOutcome(id)).toBe("empty-source");
	});

	it("records a diagnostic when the collection has no SEO panel", async () => {
		await configureEndpoint();
		await host!.fixtures.collection({
			slug: "notes",
			label: "Notes",
			hasSeo: false,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const created = await host!.actions.content.create("notes", { data: { title: "A note" } });
		if (!created.success || !created.data) throw new Error("create failed");
		const id = created.data.item.id;
		const publish = await host!.actions.content.publish("notes", id);
		if (!publish.success) throw new Error("publish failed");
		await host!.waitForDeferredTasks();

		expect(host!.http.requests()).toHaveLength(0);
		expect(await latestOutcome(id)).toBe("seo-disabled");
	});
});

describe("page:metadata serving", () => {
	it("serves the stored description without an AI request at page render", async () => {
		await configureEndpoint();
		await host!.http.respond(ENDPOINT, completion("C".repeat(110)));
		const id = await createArticle({
			title: "Rendered article",
			body: "Body text for rendering.".repeat(25),
		});
		await publishArticle(id);

		const before = host!.http.requests().length;
		const contributions = (await host!.transport.invokeHook("page:metadata", {
			page: {
				url: "https://plugin.test/articles/rendered-article",
				path: "/articles/rendered-article",
				locale: "en",
				kind: "content",
				pageType: "articles",
				title: "Rendered article",
				description: null,
				canonical: null,
				image: null,
				content: { collection: "articles", id, slug: "rendered-article" },
			},
		})) as Array<{ kind: string; name?: string; content?: string }> | null;

		expect(contributions).toEqual([
			{ kind: "meta", name: "description", content: "C".repeat(110) },
		]);
		// No AI request happened at page render time.
		expect(host!.http.requests().length).toBe(before);
	});

	it("contributes nothing when the page already has a description", async () => {
		await configureEndpoint();
		await host!.http.respond(ENDPOINT, completion("D".repeat(110)));
		const id = await createArticle({
			title: "Has description",
			body: "Body text.".repeat(25),
		});
		await publishArticle(id);

		const contributions = (await host!.transport.invokeHook("page:metadata", {
			page: {
				url: "https://plugin.test/articles/has-description",
				path: "/articles/has-description",
				locale: "en",
				kind: "content",
				pageType: "articles",
				title: "Has description",
				description: "Site-provided description.",
				canonical: null,
				image: null,
				content: { collection: "articles", id, slug: "has-description" },
			},
		})) as unknown[] | null;
		expect(contributions).toBeNull();
	});
});

describe("endpoint failures", () => {
	it("leaves the entry live and the description untouched on a 500 response", async () => {
		await configureEndpoint();
		await host!.http.respond(ENDPOINT, new Response("upstream down", { status: 500 }));
		const id = await createArticle({
			title: "Failure article",
			body: "Body text.".repeat(30),
		});
		await publishArticle(id);

		const view = await pluginView("articles", id);
		expect(view?.seoDescription == null || view.seoDescription === "").toBe(true);
		// Publish itself was not disturbed: the entry is live.
		expect(view?.status).toBe("published");
		expect(await latestOutcome(id)).toBe("endpoint");
	});

	it("treats an unreachable endpoint as a failure and records it", async () => {
		await configureEndpoint();
		// Queue no response: the test fetch throws, which the client maps to
		// an unreachable endpoint. The plugin must still leave publishing intact.
		const id = await createArticle({
			title: "Timeout article",
			body: "Body text.".repeat(30),
		});
		await publishArticle(id);
		expect(host!.http.requests()).toHaveLength(1);
		const view = await pluginView("articles", id);
		expect(view?.seoDescription == null || view.seoDescription === "").toBe(true);
	});
});

describe("output validation", () => {
	it("trims an over-long generation to the length contract", async () => {
		await configureEndpoint();
		await host!.http.respond(ENDPOINT, completion("word ".repeat(120)));
		const id = await createArticle({ title: "Too long", body: "Body text.".repeat(30) });
		await publishArticle(id);
		const generated = (await pluginView("articles", id))?.seoDescription ??
			(await fallbackDescription("articles", id));
		expect(generated?.length).toBeLessThanOrEqual(160);
		expect(generated).not.toBe("word ".repeat(120).trim());
	});

	it("rejects a refusal reply instead of saving it", async () => {
		await configureEndpoint();
		await host!.http.respond(ENDPOINT, completion("I cannot summarize this article."));
		const id = await createArticle({ title: "Refusal", body: "Body text.".repeat(30) });
		await publishArticle(id);
		const generated = (await pluginView("articles", id))?.seoDescription ??
			(await fallbackDescription("articles", id));
		expect(generated).toBeNull();
	});

	it("rejects an empty model reply instead of saving it", async () => {
		await configureEndpoint();
		await host!.http.respond(ENDPOINT, completion(""));
		const id = await createArticle({ title: "Empty reply", body: "Body text.".repeat(30) });
		await publishArticle(id);
		const generated = (await pluginView("articles", id))?.seoDescription ??
			(await fallbackDescription("articles", id));
		expect(generated).toBeNull();
	});

	it("rejects a reply containing a link", async () => {
		await configureEndpoint();
		await host!.http.respond(
			ENDPOINT,
			completion(
				"Read more about this topic at https://example.com/very-long-url-path and much more text follows here to pad the length properly to pass.",
			),
		);
		const id = await createArticle({ title: "Link reply", body: "Body text.".repeat(30) });
		await publishArticle(id);
		const generated = (await pluginView("articles", id))?.seoDescription ??
			(await fallbackDescription("articles", id));
		expect(generated).toBeNull();
	});
});

describe("publish retries and races", () => {
	it("does not bill a second request when the same text is already described", async () => {
		await configureEndpoint();
		await host!.http.respond(ENDPOINT, completion("B".repeat(90)));
		const id = await createArticle({
			title: "Idempotent",
			body: "Repeated body.".repeat(40),
		});
		await publishArticle(id);

		const generated = (await pluginView("articles", id))?.seoDescription ??
			(await fallbackDescription("articles", id));
		expect(generated).toBe("B".repeat(90));
		expect(host!.http.requests()).toHaveLength(1);

		// Republish the same content: no additional request, description kept.
		const publish = await host!.actions.content.publish("articles", id);
		if (!publish.success) throw new Error("republish failed");
		await host!.waitForDeferredTasks();
		expect(host!.http.requests()).toHaveLength(1);
	});

	it("never leaks the token through settings storage or diagnostics", async () => {
		await configureEndpoint();
		// The raw persisted envelope must not contain plaintext.
		const raw = await host!.inspect.settings.raw("apiKey");
		expect(raw).toBeTruthy();
		expect(JSON.stringify(raw)).not.toContain(TOKEN);

		const diagnostics = await host!.transport.invokeRoute("diagnostics");
		expect(JSON.stringify(diagnostics)).not.toContain(TOKEN);
	});
});

describe("configuration handling", () => {
	it("skips generation entirely when no token is configured", async () => {
		await host!.actions.plugin.updateSettings({
			enabled: true,
			endpoint: ENDPOINT,
			model: "gpt-4o-mini",
			minLength: 70,
			maxLength: 160,
		});
		const id = await createArticle({ title: "No token", body: "Body text.".repeat(30) });
		await publishArticle(id);
		expect(host!.http.requests()).toHaveLength(0);
		expect(await latestOutcome(id)).toBe("config:TOKEN_MISSING");
	});

	it("rejects an endpoint outside the supported host list as a setup error", async () => {
		await host!.actions.plugin.updateSettings({
			enabled: true,
			endpoint: "https://evil.example.com/v1/chat/completions",
			model: "gpt-4o-mini",
			apiKey: TOKEN,
		});
		const id = await createArticle({ title: "Bad host", body: "Body text.".repeat(30) });
		await publishArticle(id);
		expect(host!.http.requests()).toHaveLength(0);
		expect(await latestOutcome(id)).toBe("config:ENDPOINT_HOST_UNSUPPORTED");
	});

	it("respects the enabled=false setting", async () => {
		await host!.actions.plugin.updateSettings({
			enabled: false,
			endpoint: ENDPOINT,
			model: "gpt-4o-mini",
			apiKey: TOKEN,
		});
		const id = await createArticle({ title: "Disabled", body: "Body text.".repeat(30) });
		await publishArticle(id);
		expect(host!.http.requests()).toHaveLength(0);
	});
});

describe("admin routes", () => {
	it("reports configuration state on the diagnostics route", async () => {
		await configureEndpoint();
		const diagnostics = (await host!.transport.invokeRoute("diagnostics")) as {
			ok: boolean;
			configured: boolean;
			issue: string | null;
			config: { endpointHost: string; model: string } | null;
		};
		expect(diagnostics.ok).toBe(true);
		expect(diagnostics.configured).toBe(true);
		expect(diagnostics.config?.endpointHost).toBe("api.openai.com");
		expect(diagnostics.config?.model).toBe("gpt-4o-mini");
		expect(JSON.stringify(diagnostics)).not.toContain(TOKEN);
	});

	it("reports the endpoint result of the connectivity probe", async () => {
		await configureEndpoint();
		await host!.http.respond(ENDPOINT, completion("OK"));
		const result = (await host!.transport.invokeRoute("test-endpoint")) as {
			ok: boolean;
			host: string;
		};
		expect(result.ok).toBe(true);
		expect(result.host).toBe("api.openai.com");
	});
});
