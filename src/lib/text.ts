/**
 * Source-text extraction.
 *
 * The plugin reads the published entry's field values and flattens them into
 * plain text to send to the configured endpoint. Portable Text is converted
 * with EmDash's own converter so rich prose keeps its wording; references,
 * media, and unknown structures contribute nothing rather than inventing text.
 */

import { portableTextToMarkdown } from "emdash/client";

/** Upper bound on characters sent to the endpoint, keeping requests small. */
export const MAX_SOURCE_CHARS = 12_000;

const TEXT_FIELD_BUDGET = 24;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys inside structured values that may carry prose worth summarising. */
const PROSE_KEYS = new Set([
	"text",
	"body",
	"content",
	"caption",
	"alt",
	"excerpt",
	"summary",
	"description",
	"heading",
	"subtitle",
	"label",
	"name",
	"value",
	"quote",
]);

function isPortableTextBlocks(
	value: unknown,
): value is Array<Record<string, unknown> & { _type: string }> {
	if (!Array.isArray(value) || value.length === 0) return false;
	// Real Portable Text blocks carry span children; unknown structures such as
	// references or media values must not be converted (the converter would
	// serialise them as opaque fences and leak identifiers into the prompt).
	return (
		isPlainRecord(value[0]) &&
		typeof value[0]._type === "string" &&
		Array.isArray(value[0].children)
	);
}

/**
 * Strings that are never prose: URLs, media keys, hashes, and identifiers.
 * Sending them to the model would invite the endpoint to echo structure back.
 */
function isNonProseString(value: string): boolean {
	if (/^https?:\/\//i.test(value)) return true;
	if (/\//.test(value) && !/\s/.test(value)) return true; // paths and URLs
	// ULID, hex digests, base64url blobs, or any long whitespace-free token.
	if (!/\s/.test(value) && value.length >= 26) return true;
	return false;
}

/** Strip markdown emphasis/link syntax left over from Portable Text. */
function stripMarkup(text: string): string {
	return text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`]{1,3}/g, "")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^>\s+/gm, "")
		.replace(/^[-+*]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

function collectParts(value: unknown, parts: string[], depth: number): void {
	if (parts.length >= TEXT_FIELD_BUDGET) return;

	if (typeof value === "string") {
		if (isNonProseString(value)) return;
		const cleaned = stripMarkup(value);
		if (cleaned !== "") parts.push(cleaned);
		return;
	}

	if (isPortableTextBlocks(value)) {
		const markdown = stripMarkup(portableTextToMarkdown(value as Parameters<typeof portableTextToMarkdown>[number]));
		if (markdown !== "") parts.push(markdown);
		return;
	}

	if (Array.isArray(value)) {
		for (const entry of value) {
			if (parts.length >= TEXT_FIELD_BUDGET) return;
			collectParts(entry, parts, depth + 1);
		}
		return;
	}

	if (depth > 3 || !isPlainRecord(value)) return;

	// Inside structured values, only prose-carrying keys contribute text.
	// Media, references, and geometry stay out of the prompt entirely.
	for (const [key, entry] of Object.entries(value)) {
		if (parts.length >= TEXT_FIELD_BUDGET) return;
		if (key.startsWith("_") || !PROSE_KEYS.has(key)) continue;
		collectParts(entry, parts, depth + 1);
	}
}

export interface SourceText {
	title: string;
	body: string;
	charCount: number;
}

/**
 * Flatten an entry's field values into a title plus body text.
 *
 * Returns `charCount: 0` when the entry carries no prose at all, which the
 * caller treats as "nothing to summarise" instead of sending an empty prompt.
 */
export function extractSourceText(
	data: Record<string, unknown>,
): SourceText {
	const titleParts: string[] = [];
	const bodyParts: string[] = [];

	for (const [key, value] of Object.entries(data)) {
		if (key === "id" || key.startsWith("_")) continue;
		const isTitle = key === "title" || key === "headline" || key === "name";
		const before = bodyParts.length;
		collectParts(value, isTitle ? titleParts : bodyParts, 0);
		if (!isTitle && bodyParts.length === before && typeof value === "string") {
			// Field name is a strong hint for the model, so label loose strings.
			const cleaned = stripMarkup(value);
			if (cleaned !== "") bodyParts.push(`${key}: ${cleaned}`);
		}
	}

	const title = titleParts.join(" ").trim();
	const body = bodyParts.join("\n\n").trim();
	const combined = body.slice(0, MAX_SOURCE_CHARS);
	return { title, body: combined, charCount: combined.length };
}
