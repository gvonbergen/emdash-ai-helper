import { describe, expect, it } from "vitest";

import {
	buildPrompt,
	describeOutput,
	normalizeDescription,
	validateDescription,
} from "../src/lib/describe.js";
import type { SourceText } from "../src/lib/text.js";

const source: SourceText = {
	title: "Alpine hiking routes",
	body: "The tram from Lucerne is closed in winter. Hikers should carry microspikes.",
	charCount: 78,
};

describe("prompt construction", () => {
	it("includes the length contract, locale, and source text", () => {
		const prompt = buildPrompt(source, "de", 70, 160);
		expect(prompt.system).toContain("70 and 160 characters");
		expect(prompt.system).toContain('"de"');
		expect(prompt.system).toContain("only facts stated in the article");
		expect(prompt.user).toContain("Alpine hiking routes");
		expect(prompt.user).toContain("Hikers should carry microspikes");
	});

	it("handles an entry without a title", () => {
		const prompt = buildPrompt({ title: "", body: "Body only.", charCount: 10 }, "en", 70, 160);
		expect(prompt.user).not.toContain("Title:");
		expect(prompt.user).toContain("Body only.");
	});

	it("marks an entry without body text", () => {
		const prompt = buildPrompt({ title: "T", body: "", charCount: 0 }, "en", 70, 160);
		expect(prompt.user).toContain("(no body text)");
	});
});

describe("description validation", () => {
	it("accepts a plain description inside the length contract", () => {
		const value = "A".repeat(120);
		expect(validateDescription(value, 70, 160)).toEqual({ ok: true, value });
	});

	it("rejects empty text", () => {
		expect(validateDescription("", 70, 160)).toEqual({ ok: false, issue: "EMPTY" });
	});

	it("rejects text shorter than the minimum", () => {
		expect(validateDescription("A".repeat(20), 70, 160)).toEqual({ ok: false, issue: "TOO_SHORT" });
	});

	it("rejects text longer than the maximum", () => {
		expect(validateDescription("A".repeat(200), 70, 160)).toEqual({ ok: false, issue: "TOO_LONG" });
	});

	it("rejects text containing links", () => {
		const value = `${"A".repeat(100)} https://example.com`;
		expect(validateDescription(value, 70, 160)).toEqual({ ok: false, issue: "CONTAINS_LINK" });
	});

	it("rejects text containing markup characters", () => {
		const value = `Best <b>trails</b> ${"A".repeat(100)}`;
		expect(validateDescription(value, 70, 160)).toEqual({ ok: false, issue: "NOT_PLAIN_TEXT" });
	});

	it("rejects refusal replies", () => {
		const value = `I cannot summarize this. ${"A".repeat(100)}`;
		expect(validateDescription(value, 70, 160)).toEqual({ ok: false, issue: "REFUSAL" });
	});
});

describe("normalization", () => {
	it("unwraps wrapping quotes and collapses newlines", () => {
		const normalized = normalizeDescription('"First line.\n\nSecond line." ', 160);
		expect(normalized).toBe("First line. Second line.");
	});

	it("strips a leading label", () => {
		expect(normalizeDescription("Meta description: A fine text.", 160)).toBe("A fine text.");
	});

	it("trims long text at a word boundary", () => {
		const words = Array.from({ length: 80 }, () => "wordish").join(" ");
		const normalized = normalizeDescription(words, 160);
		expect(normalized.length).toBeLessThanOrEqual(160);
		expect(normalized.endsWith("wordish")).toBe(true);
	});

	it("drops trailing punctuation after trimming", () => {
		const normalized = normalizeDescription(`A. ${"B".repeat(200)}`, 160);
		expect(/[.,;:\-–]$/.test(normalized)).toBe(false);
	});
});

describe("describeOutput", () => {
	it("validates a normalized answer end to end", () => {
		const result = describeOutput(`  ${"C".repeat(150)}  `, 70, 160);
		expect(result).toEqual({ ok: true, value: "C".repeat(150) });
	});

	it("rejects a normalized answer below the minimum", () => {
		expect(describeOutput("Short.", 70, 160)).toEqual({ ok: false, issue: "TOO_SHORT" });
	});
});
