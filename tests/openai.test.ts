import { describe, expect, it } from "vitest";

import { requestDescription, safeFailureText, type GenerationResult } from "../src/lib/openai.js";
import type { EndpointConfig } from "../src/lib/config.js";

const TOKEN = "sk-super-secret-token-value-9876543210";

function config(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
	return {
		endpoint: "https://api.openai.com/v1/chat/completions",
		host: "api.openai.com",
		model: "gpt-4o-mini",
		apiKey: TOKEN,
		minLength: 70,
		maxLength: 160,
		timeoutMs: 8000,
		maxAttempts: 3,
		retryCooldownMs: 3_600_000,
		...overrides,
	};
}

const PROMPT = { system: "sys", user: "usr" };

function okResponse(text: string): Response {
	return new Response(
		JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }] }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("requestDescription", () => {
	it("returns the model text for a successful completion", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const http = {
			async fetch(url: string, init?: RequestInit) {
				calls.push({ url, init });
				return okResponse("A fine description.");
			},
		};
		const result = await requestDescription(http, config(), PROMPT);
		expect(result).toMatchObject({ ok: true, text: "A fine description." });

		const body = JSON.parse(calls[0]!.init!.body as string) as {
			model: string;
			max_tokens: number;
			messages: Array<{ role: string }>;
		};
		expect(body.model).toBe("gpt-4o-mini");
		expect(body.max_tokens).toBeGreaterThan(0);
		expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
	});

	it("sends the token only inside the Authorization header", async () => {
		const calls: Array<{ init?: RequestInit }> = [];
		const http = {
			async fetch(_url: string, init?: RequestInit) {
				calls.push({ init });
				return okResponse("Answer.");
			},
		};
		await requestDescription(http, config(), PROMPT);
		const headers = new Headers(calls[0]!.init!.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(String(calls[0]!.init!.body)).not.toContain(TOKEN);
	});

	it("maps 4xx and 5xx responses to stable failures", async () => {
		const http = (status: number) => ({
			async fetch() {
				return new Response("nope", { status });
			},
		});
		const result401 = await requestDescription(http(401), config(), PROMPT);
		expect(result401).toEqual({ ok: false, failure: "HTTP_4XX", status: 401 });
		const result503 = await requestDescription(http(503), config(), PROMPT);
		expect(result503).toEqual({ ok: false, failure: "HTTP_5XX", status: 503 });
	});

	it("maps network errors to UNREACHABLE and timeouts to TIMEOUT", async () => {
		const unreachable = {
			async fetch() {
				throw new Error("connect ECONNREFUSED");
			},
		};
		expect(await requestDescription(unreachable, config(), PROMPT)).toEqual({
			ok: false,
			failure: "UNREACHABLE",
		});

		const hanging = {
			async fetch(_url: string, init?: RequestInit) {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
				});
			},
		};
		const fast = config({ timeoutMs: 1000 });
		const started = Date.now();
		const result = await requestDescription(hanging, fast, PROMPT);
		expect(result).toEqual({ ok: false, failure: "TIMEOUT" });
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("maps non-JSON and empty-choice bodies to BAD_RESPONSE / EMPTY_CANDIDATE", async () => {
		const notJson = {
			async fetch() {
				return new Response("<html>rate limit</html>", { status: 200 });
			},
		};
		expect(await requestDescription(notJson, config(), PROMPT)).toEqual({
			ok: false,
			failure: "BAD_RESPONSE",
		});

		const emptyChoice = {
			async fetch() {
				return okResponse("   ");
			},
		};
		expect(await requestDescription(emptyChoice, config(), PROMPT)).toEqual({
			ok: false,
			failure: "EMPTY_CANDIDATE",
		});
	});
});

describe("safeFailureText", () => {
	it("never contains the API token", () => {
		const results: GenerationResult[] = [
			{ ok: false, failure: "UNREACHABLE" },
			{ ok: false, failure: "HTTP_4XX", status: 401 },
			{ ok: false, failure: "TIMEOUT" },
		];
		for (const result of results) {
			if (result.ok) continue;
			const text = safeFailureText(result, TOKEN);
			expect(text).not.toContain(TOKEN);
			expect(text).toBeTypeOf("string");
			expect(text.length).toBeLessThan(40);
		}
	});
});
