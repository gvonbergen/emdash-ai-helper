import { describe, expect, it } from "vitest";

import {
	DEFAULT_ENDPOINT,
	DEFAULT_MODEL,
	normalizeEndpoint,
	resolveConfig,
	SUPPORTED_ENDPOINT_HOSTS,
} from "../src/lib/config.js";

/**
 * A settings access shaped like EmDash's `SettingsAccess`. It records every
 * `list()` and `get()` call so tests can assert the one-batch-read contract:
 * `resolveConfig` must read through `list()` at most once per invocation and
 * never fall back to per-key reads.
 */
function settingsWith(values: Record<string, unknown>) {
	const calls = { list: 0, get: [] as string[] };
	return {
		get<T>(key: string): Promise<T | null> {
			calls.get.push(key);
			return Promise.resolve((key in values ? values[key] : null) as T | null);
		},
		list(): Promise<Array<{ key: string; value: unknown }>> {
			calls.list += 1;
			return Promise.resolve(
				Object.entries(values).map(([key, value]) => ({ key, value })),
			);
		},
		calls,
	};
}

/** Assert the one-batch-read contract: exactly one `list`, zero per-key `get`s. */
function expectOneSettingsRead(calls: { list: number; get: string[] }): void {
	expect(calls.list).toBe(1);
	expect(calls.get).toEqual([]);
}

describe("endpoint normalization", () => {
	it("completes a versioned base URL to the chat completions path", () => {
		const result = normalizeEndpoint("https://api.openai.com/v1");
		expect("url" in result).toBe(true);
		if ("url" in result) {
			expect(result.url.toString()).toBe("https://api.openai.com/v1/chat/completions");
		}
	});

	it("keeps a full chat completions URL unchanged", () => {
		const result = normalizeEndpoint("https://api.groq.com/openai/v1/chat/completions");
		expect("url" in result).toBe(true);
	});

	it("rejects plaintext HTTP endpoints", () => {
		const result = normalizeEndpoint("http://api.openai.com/v1/chat/completions");
		expect(result).toEqual({ issue: "ENDPOINT_NOT_HTTPS" });
	});

	it("rejects endpoints with embedded credentials", () => {
		const result = normalizeEndpoint("https://user:pass@api.openai.com/v1/chat/completions");
		expect(result).toEqual({ issue: "ENDPOINT_HAS_CREDENTIALS" });
	});

	it("rejects endpoints with query strings", () => {
		const result = normalizeEndpoint("https://api.openai.com/v1/chat/completions?key=x");
		expect(result).toEqual({ issue: "ENDPOINT_HAS_CREDENTIALS" });
	});

	it("rejects hosts outside the declared allowlist", () => {
		const result = normalizeEndpoint("https://evil.example.com/v1/chat/completions");
		expect(result).toEqual({ issue: "ENDPOINT_HOST_UNSUPPORTED" });
	});

	it("rejects unsupported paths on supported hosts", () => {
		const result = normalizeEndpoint("https://api.openai.com/v1/embeddings");
		expect(result).toEqual({ issue: "ENDPOINT_PATH_UNSUPPORTED" });
	});

	it("rejects unparseable URLs and empty values", () => {
		expect(normalizeEndpoint("not a url")).toEqual({ issue: "ENDPOINT_INVALID" });
		expect(normalizeEndpoint("")).toEqual({ issue: "ENDPOINT_MISSING" });
	});

	it("supports every declared allowlist host", () => {
		for (const host of SUPPORTED_ENDPOINT_HOSTS) {
			const result = normalizeEndpoint(`https://${host}/v1`);
			expect("url" in result).toBe(true);
		}
	});
});

describe("resolveConfig", () => {
	it("applies defaults for endpoint and model", async () => {
		const settings = settingsWith({ apiKey: " sk-test-value " });
		const resolved = await resolveConfig(settings);
		expectOneSettingsRead(settings.calls);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.config.endpoint).toBe(DEFAULT_ENDPOINT);
			expect(resolved.config.model).toBe(DEFAULT_MODEL);
			expect(resolved.config.apiKey).toBe("sk-test-value");
			expect(resolved.config.minLength).toBe(70);
			expect(resolved.config.maxLength).toBe(160);
			expect(resolved.config.timeoutMs).toBe(8000);
			expect(resolved.config.maxAttempts).toBe(3);
		}
	});

	it("reads the batch exactly once when every setting is saved", async () => {
		const settings = settingsWith({
			enabled: true,
			endpoint: "https://api.groq.com/openai/v1/chat/completions",
			model: "llama-3.1-8b-instant",
			apiKey: "sk-test-1234567890abcdef",
			minLength: 80,
			maxLength: 200,
			timeoutMs: 12_000,
			maxAttempts: 5,
		});
		const resolved = await resolveConfig(settings);
		expectOneSettingsRead(settings.calls);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.config.endpoint).toBe("https://api.groq.com/openai/v1/chat/completions");
			expect(resolved.config.model).toBe("llama-3.1-8b-instant");
			expect(resolved.config.apiKey).toBe("sk-test-1234567890abcdef");
			expect(resolved.config.minLength).toBe(80);
			expect(resolved.config.maxLength).toBe(200);
			expect(resolved.config.timeoutMs).toBe(12_000);
			expect(resolved.config.maxAttempts).toBe(5);
		}
	});

	it("reads the batch exactly once for a partial configuration and keeps the defaults", async () => {
		// Only the required token was saved: endpoint, model, and the numeric
		// tuning values all come from the local defaults, not per-key reads.
		const settings = settingsWith({ apiKey: "sk-test-value", minLength: 90 });
		const resolved = await resolveConfig(settings);
		expectOneSettingsRead(settings.calls);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.config.endpoint).toBe(DEFAULT_ENDPOINT);
			expect(resolved.config.model).toBe(DEFAULT_MODEL);
			expect(resolved.config.minLength).toBe(90);
			expect(resolved.config.maxLength).toBe(160);
			expect(resolved.config.timeoutMs).toBe(8000);
			expect(resolved.config.maxAttempts).toBe(3);
		}
	});

	it("reads the batch exactly once when nothing is saved and reports the missing token", async () => {
		const settings = settingsWith({});
		const resolved = await resolveConfig(settings);
		expectOneSettingsRead(settings.calls);
		expect(resolved).toEqual({ ok: false, issue: "TOKEN_MISSING" });
	});

	it("reports a blank token", async () => {
		const settings = settingsWith({ apiKey: "   " });
		const resolved = await resolveConfig(settings);
		expectOneSettingsRead(settings.calls);
		expect(resolved).toEqual({ ok: false, issue: "TOKEN_MISSING" });
	});

	it("respects enabled=false from the single batch read", async () => {
		const settings = settingsWith({ enabled: false });
		const resolved = await resolveConfig(settings);
		expectOneSettingsRead(settings.calls);
		expect(resolved).toEqual({ ok: false, issue: "ENDPOINT_MISSING" });
	});

	it("surfaces endpoint issues as configuration problems", async () => {
		const settings = settingsWith({
			apiKey: "k",
			endpoint: "https://api.openai.com/wrong",
		});
		const resolved = await resolveConfig(settings);
		expectOneSettingsRead(settings.calls);
		expect(resolved).toEqual({ ok: false, issue: "ENDPOINT_PATH_UNSUPPORTED" });
	});

	it("clamps length bounds and keeps min <= max", async () => {
		const settings = settingsWith({ apiKey: "k", minLength: 500, maxLength: 100 });
		const resolved = await resolveConfig(settings);
		expectOneSettingsRead(settings.calls);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.config.minLength).toBe(160);
			expect(resolved.config.maxLength).toBe(160);
		}
	});

	it("clamps the timeout into the supported window", async () => {
		const settings = settingsWith({ apiKey: "k", timeoutMs: 1 });
		const resolved = await resolveConfig(settings);
		expectOneSettingsRead(settings.calls);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) expect(resolved.config.timeoutMs).toBe(1000);
	});
});
