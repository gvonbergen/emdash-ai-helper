/**
 * OpenAI-compatible chat-completions client.
 *
 * Sends one request per generated description through `ctx.http.fetch`, which
 * EmDash enforces against the manifest's `allowedHosts` and SSRF-validates.
 * Errors are mapped to stable codes; response bodies, tokens, and request
 * payloads are never included in an error message.
 */

import type { EndpointConfig } from "./config.ts";
import type { Prompt } from "./describe.ts";

export type GenerationFailure =
	| "TIMEOUT"
	| "UNREACHABLE"
	| "HTTP_4XX"
	| "HTTP_5XX"
	| "BAD_RESPONSE"
	| "EMPTY_CANDIDATE";

export type GenerationResult =
	| { ok: true; text: string; finishReason: string | null }
	| { ok: false; failure: GenerationFailure; status?: number };

/** Max completion tokens: a meta description needs far fewer than one page. */
const MAX_COMPLETION_TOKENS = 96;

/** Upper bound on the prompt, matching the source-text budget. */
const MAX_PROMPT_CHARS = 24_000;

interface ChatCompletionResponse {
	choices?: Array<{
		finish_reason?: string | null;
		message?: { content?: unknown };
	}>;
	error?: { message?: unknown };
}

function redact(text: string, apiKey: string): string {
	let out = text;
	if (apiKey.length > 3) out = out.split(apiKey).join("[redacted]");
	return out.replace(/https?:\/\/[^\s"]*?([?#][^\s"]*)/g, (url) => url.split(/[?#]/)[0]!);
}

/**
 * Request one description from the configured endpoint.
 *
 * The request is aborted after `config.timeoutMs`. A timeout is reported as
 * `TIMEOUT`, an unreachable host as `UNREACHABLE`; neither is retried inside
 * this call, so a publish attempt costs at most one request.
 */
export async function requestDescription(
	http: { fetch(url: string, init?: RequestInit): Promise<Response> },
	config: EndpointConfig,
	prompt: Prompt,
): Promise<GenerationResult> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		timer = setTimeout(() => controller.abort(), config.timeoutMs);

		let response: Response;
		try {
			response = await http.fetch(config.endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${config.apiKey}`,
				},
				body: JSON.stringify({
					model: config.model,
					messages: [
						{ role: "system", content: prompt.system.slice(0, MAX_PROMPT_CHARS) },
						{ role: "user", content: prompt.user.slice(0, MAX_PROMPT_CHARS) },
					],
					temperature: 0.2,
					max_tokens: MAX_COMPLETION_TOKENS,
				}),
				signal: controller.signal,
			});
		} catch (error) {
			if (controller.signal.aborted) return { ok: false, failure: "TIMEOUT" };
			return { ok: false, failure: "UNREACHABLE" };
		}

		if (!response.ok) {
			// Drain the body so the connection closes cleanly, then report only
			// the status class. Provider messages can contain account data.
			await response.text().catch(() => undefined);
			return {
				ok: false,
				failure: response.status >= 500 ? "HTTP_5XX" : "HTTP_4XX",
				status: response.status,
			};
		}

		let payload: ChatCompletionResponse;
		try {
			payload = (await response.json()) as ChatCompletionResponse;
		} catch {
			return { ok: false, failure: "BAD_RESPONSE" };
		}

		const choice = payload.choices?.[0];
		const content = choice?.message?.content;
		if (typeof content !== "string" || content.trim() === "") {
			return { ok: false, failure: "EMPTY_CANDIDATE" };
		}

		return {
			ok: true,
			text: content,
			finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Turn a generation result into a safe diagnostic string.
 *
 * Guarantees the API token and any query-string credentials cannot appear in
 * the returned text, so callers can log and store it.
 */
export function safeFailureText(
	result: { ok: false; failure: GenerationFailure; status?: number },
	apiKey: string,
): string {
	const base =
		result.status === undefined
			? result.failure
			: `${result.failure}:${result.status}`;
	return redact(base, apiKey);
}
