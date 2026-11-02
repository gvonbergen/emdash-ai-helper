import { describe, expect, it } from "vitest";

import {
	DEFAULT_ENDPOINT,
	DEFAULT_MODEL,
	normalizeEndpoint,
	resolveConfig,
	SUPPORTED_ENDPOINT_HOSTS,
} from "../src/lib/config.js";

function settingsWith(values: Record<string, unknown>) {
	return {
		get<T>(key: string): Promise<T | null> {
			return Promise.resolve((key in values ? values[key] : null) as T | null);
		},
	};
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
		const resolved = await resolveConfig(settingsWith({ apiKey: " sk-test-value " }));
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

	it("reports a missing token", async () => {
		const resolved = await resolveConfig(settingsWith({}));
		expect(resolved).toEqual({ ok: false, issue: "TOKEN_MISSING" });
	});

	it("reports a blank token", async () => {
		const resolved = await resolveConfig(settingsWith({ apiKey: "   " }));
		expect(resolved).toEqual({ ok: false, issue: "TOKEN_MISSING" });
	});

	it("respects enabled=false without reading other settings", async () => {
		const resolved = await resolveConfig(settingsWith({ enabled: false }));
		expect(resolved).toEqual({ ok: false, issue: "ENDPOINT_MISSING" });
	});

	it("surfaces endpoint issues as configuration problems", async () => {
		const resolved = await resolveConfig(
			settingsWith({ apiKey: "k", endpoint: "https://api.openai.com/wrong" }),
		);
		expect(resolved).toEqual({ ok: false, issue: "ENDPOINT_PATH_UNSUPPORTED" });
	});

	it("clamps length bounds and keeps min <= max", async () => {
		const resolved = await resolveConfig(
			settingsWith({ apiKey: "k", minLength: 500, maxLength: 100 }),
		);
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.config.minLength).toBe(160);
			expect(resolved.config.maxLength).toBe(160);
		}
	});

	it("clamps the timeout into the supported window", async () => {
		const resolved = await resolveConfig(settingsWith({ apiKey: "k", timeoutMs: 1 }));
		expect(resolved.ok).toBe(true);
		if (resolved.ok) expect(resolved.config.timeoutMs).toBe(1000);
	});
});
