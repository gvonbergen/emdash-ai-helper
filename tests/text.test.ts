import { describe, expect, it } from "vitest";

import { extractSourceText, MAX_SOURCE_CHARS } from "../src/lib/text.js";

describe("extractSourceText", () => {
	it("separates title fields from body fields", () => {
		const result = extractSourceText({
			title: "Winter hiking",
			body: "Trails close after the first snowfall.",
		});
		expect(result.title).toBe("Winter hiking");
		expect(result.body).toContain("Trails close after the first snowfall");
		expect(result.charCount).toBeGreaterThan(0);
	});

	it("converts Portable Text blocks to plain text", () => {
		const result = extractSourceText({
			title: "Museums",
			content: [
				{
					_type: "block",
					style: "normal",
					children: [{ _type: "span", text: "The museum opens at nine." }],
				},
			],
		});
		expect(result.body).toContain("The museum opens at nine.");
	});

	it("strips markdown emphasis and links from prose", () => {
		const result = extractSourceText({
			title: "Marked",
			body: "This [link text](https://example.com) stays readable.",
		});
		expect(result.body).toContain("link text stays readable");
		expect(result.body).not.toContain("https://");
	});

	it("ignores media and reference structures without inventing text", () => {
		const result = extractSourceText({
			title: "Gallery",
			cover: { _type: "image", url: "https://example.com/a.jpg" },
			related: [{ _type: "reference", id: "abc" }],
		});
		expect(result.body).not.toContain("example.com");
		expect(result.body).not.toContain("abc");
	});

	it("returns zero characters for an entry without prose", () => {
		const result = extractSourceText({ views: 42, cover: { _type: "image", url: "https://example.com/a.jpg" } });
		expect(result.charCount).toBe(0);
		expect(result.body).toBe("");
	});

	it("skips internal keys and ids", () => {
		const result = extractSourceText({
			_id: "internal",
			id: "abc123",
			title: "Fine",
			body: "Text.",
		});
		expect(result.title).not.toContain("internal");
	});

	it("caps the source text at the configured budget", () => {
		const result = extractSourceText({
			title: "Long",
			body: "sentence ".repeat(MAX_SOURCE_CHARS / 4),
		});
		expect(result.charCount).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
	});
});
