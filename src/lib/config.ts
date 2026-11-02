/**
 * Admin-owned runtime configuration for the AI endpoint.
 *
 * Everything here is resolved from plugin settings written by a site
 * administrator in the EmDash admin (Settings → EmDash AI Helper). Nothing is
 * read from content, request payloads, or author-controlled configuration, so
 * a content editor cannot steer where the plugin sends data.
 *
 * The endpoint contract is OpenAI-compatible chat completions:
 * `POST <endpoint>` with `Authorization: Bearer <token>` and a JSON body of
 * `{ model, messages, temperature, max_tokens }`, answered with
 * `{ choices: [{ message: { content } }] }`.
 */

/** Endpoint used when the administrator has not set one. */
export const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";

/** Model used when the administrator has not set one. */
export const DEFAULT_MODEL = "gpt-4o-mini";

/** Character targets for a generated meta description. */
export const DEFAULT_MIN_LENGTH = 70;
export const DEFAULT_MAX_LENGTH = 160;

/** Milliseconds to wait for the endpoint before giving up. */
export const DEFAULT_TIMEOUT_MS = 8_000;

/** Publish retries that reuse a failed attempt before giving up. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Cooldown between retries of a transient failure, in milliseconds. */
export const DEFAULT_RETRY_COOLDOWN_MS = 60 * 60_000;

/** Hard bounds the administrator cannot configure past. */
const MIN_LENGTH_FLOOR = 40;
const MAX_LENGTH_CEILING = 320;
const TIMEOUT_FLOOR = 1_000;
const TIMEOUT_CEILING = 20_000;
const ATTEMPTS_FLOOR = 1;
const ATTEMPTS_CEILING = 10;

/**
 * Hosts the plugin's manifest declares in `allowedHosts`. EmDash enforces the
 * same list at the network boundary; this copy lets the plugin report a clear
 * setup error instead of a generic host-allow failure. Keep both in sync.
 */
export const SUPPORTED_ENDPOINT_HOSTS = [
	"api.openai.com",
	"api.groq.com",
	"api.together.xyz",
	"api.deepinfra.com",
	"api.fireworks.ai",
	"api.mistral.ai",
	"openrouter.ai",
	"generativelanguage.googleapis.com",
] as const;

export type ConfigIssue =
	| "ENDPOINT_MISSING"
	| "ENDPOINT_INVALID"
	| "ENDPOINT_NOT_HTTPS"
	| "ENDPOINT_HAS_CREDENTIALS"
	| "ENDPOINT_HOST_UNSUPPORTED"
	| "ENDPOINT_PATH_UNSUPPORTED"
	| "MODEL_MISSING"
	| "TOKEN_MISSING";

export interface EndpointConfig {
	endpoint: string;
	host: string;
	model: string;
	apiKey: string;
	minLength: number;
	maxLength: number;
	timeoutMs: number;
	maxAttempts: number;
	retryCooldownMs: number;
}

export type ResolvedConfig = { ok: true; config: EndpointConfig } | { ok: false; issue: ConfigIssue };

function readString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function readInteger(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
		return Math.round(Number(value));
	}
	return fallback;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * Validate and normalise an endpoint URL against the supported contract.
 *
 * Rejects non-HTTPS URLs, embedded credentials, query strings, and hosts the
 * manifest does not declare. All of these are setup errors reported to the
 * administrator; none of them reach the network.
 */
export function normalizeEndpoint(rawEndpoint: string): { url: URL } | { issue: ConfigIssue } {
	const trimmed = rawEndpoint.trim();
	if (trimmed === "") return { issue: "ENDPOINT_MISSING" };

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return { issue: "ENDPOINT_INVALID" };
	}

	if (url.protocol !== "https:") return { issue: "ENDPOINT_NOT_HTTPS" };
	if (url.username !== "" || url.password !== "") return { issue: "ENDPOINT_HAS_CREDENTIALS" };
	if (url.search !== "" || url.hash !== "") return { issue: "ENDPOINT_HAS_CREDENTIALS" };

	const host = url.hostname.toLowerCase();
	if (!(SUPPORTED_ENDPOINT_HOSTS as readonly string[]).includes(host)) {
		return { issue: "ENDPOINT_HOST_UNSUPPORTED" };
	}

	const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
	if (path.endsWith("/chat/completions")) {
		return { url: new URL(`https://${host}${path}`) };
	}
	// Accept a versioned base such as https://api.openai.com/v1 and complete it.
	if (/^\/v\d+$/.test(path)) {
		return { url: new URL(`https://${host}${path}/chat/completions`) };
	}
	return { issue: "ENDPOINT_PATH_UNSUPPORTED" };
}

/**
 * Resolve the plugin's settings into a usable endpoint configuration.
 *
 * The secret token is returned only to the caller that performs the request;
 * it is never written to storage, logs, routes, or diagnostics.
 */
export async function resolveConfig(settings: {
	get<T>(key: string): Promise<T | null>;
}): Promise<ResolvedConfig> {
	const enabled = await settings.get<boolean>("enabled");
	if (enabled === false) return { ok: false, issue: "ENDPOINT_MISSING" };

	const endpointSetting = readString(
		await settings.get<string>("endpoint"),
		DEFAULT_ENDPOINT,
	);
	const normalized = normalizeEndpoint(endpointSetting);
	if ("issue" in normalized) return { ok: false, issue: normalized.issue };

	const model = readString(await settings.get<string>("model"), DEFAULT_MODEL);
	const apiKey = await settings.get<string>("apiKey");
	if (typeof apiKey !== "string" || apiKey.trim() === "") {
		return { ok: false, issue: "TOKEN_MISSING" };
	}

	const minLength = clamp(
		readInteger(await settings.get<number>("minLength"), DEFAULT_MIN_LENGTH),
		MIN_LENGTH_FLOOR,
		DEFAULT_MAX_LENGTH,
	);
	const maxLength = clamp(
		readInteger(await settings.get<number>("maxLength"), DEFAULT_MAX_LENGTH),
		minLength,
		MAX_LENGTH_CEILING,
	);

	return {
		ok: true,
		config: {
			endpoint: normalized.url.toString(),
			host: normalized.url.hostname.toLowerCase(),
			model,
			apiKey: apiKey.trim(),
			minLength,
			maxLength,
			timeoutMs: clamp(
				readInteger(await settings.get<number>("timeoutMs"), DEFAULT_TIMEOUT_MS),
				TIMEOUT_FLOOR,
				TIMEOUT_CEILING,
			),
			maxAttempts: clamp(
				readInteger(await settings.get<number>("maxAttempts"), DEFAULT_MAX_ATTEMPTS),
				ATTEMPTS_FLOOR,
				ATTEMPTS_CEILING,
			),
			retryCooldownMs: DEFAULT_RETRY_COOLDOWN_MS,
		},
	};
}

/** A short, safe summary of the active configuration for diagnostics. */
export function describeConfig(config: EndpointConfig): Record<string, unknown> {
	return {
		endpointHost: config.host,
		model: config.model,
		minLength: config.minLength,
		maxLength: config.maxLength,
		timeoutMs: config.timeoutMs,
		maxAttempts: config.maxAttempts,
	};
}
