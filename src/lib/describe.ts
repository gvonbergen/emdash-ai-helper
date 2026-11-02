/**
 * Prompt construction and output validation.
 *
 * The contract is deliberately narrow: ask for one plain-text meta
 * description in the entry's own language, grounded only in the supplied text,
 * then validate the answer before it is written to the entry. Anything that
 * fails validation is discarded; the plugin never invents filler to reach the
 * length target.
 */

import type { SourceText } from "./text.ts";

/** Maximum characters accepted from the model before word-boundary trimming. */
const RAW_ACCEPT_LIMIT = 600;

export type DescriptionIssue =
	| "EMPTY"
	| "TOO_SHORT"
	| "TOO_LONG"
	| "NOT_PLAIN_TEXT"
	| "CONTAINS_LINK"
	| "REFUSAL";

export type ValidatedDescription =
	| { ok: true; value: string }
	| { ok: false; issue: DescriptionIssue };

export interface Prompt {
	system: string;
	user: string;
}

const REFUSAL_MARKERS = [
	"i cannot",
	"i can't",
	"i'm unable",
	"i am unable",
	"as an ai",
	"no content provided",
	"unable to summarize",
	"unable to summarise",
];

/** Build the chat-completions messages for one entry. */
export function buildPrompt(
	source: SourceText,
	locale: string,
	minLength: number,
	maxLength: number,
): Prompt {
	const system =
		`You write search-engine meta descriptions for a content-managed website. ` +
		`Write exactly one plain-text description of the article. ` +
		`Rules: between ${minLength} and ${maxLength} characters; write in the article's own language ` +
		`(the entry locale is "${locale}"); use only facts stated in the article; no invented details, ` +
		`no quotes, no markdown, no emoji, no URLs, no call to action, and no prefix such as ` +
		`"This article is about". Reply with the description text and nothing else.`;

	const user = [
		source.title === "" ? "" : `Title: ${source.title}`,
		source.body === "" ? "(no body text)" : `Article text:\n${source.body}`,
	]
		.filter((line) => line !== "")
		.join("\n\n");

	return { system, user };
}

/**
 * Normalise the model's reply into a single-line description.
 *
 * Trailing whitespace, wrapping quotes, and a leading label are removed. Long
 * replies are trimmed to the last word boundary at `maxLength`, so a model
 * that overshoots slightly is still usable.
 */
export function normalizeDescription(raw: string, maxLength: number): string {
	let text = raw
		.replace(/\r\n?/g, "\n")
		.replace(/^[\s"'“”]+/, "")
		.replace(/[\s"'“”]+$/, "")
		.replace(/^(?:meta\s+description|description)\s*[:\-–]\s*/i, "")
		.replace(/\s*\n+\s*/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	if (text.length > maxLength) {
		const window = text.slice(0, maxLength);
		const boundary = Math.max(window.lastIndexOf(" "), window.lastIndexOf("."));
		text = (boundary > Math.floor(maxLength * 0.5) ? window.slice(0, boundary) : window).trim();
		text = text.replace(/[,;:\-–\s]+$/, "");
	}

	return text;
}

/** Validate a normalized description against the configured length contract. */
export function validateDescription(
	value: string,
	minLength: number,
	maxLength: number,
): ValidatedDescription {
	if (value === "") return { ok: false, issue: "EMPTY" };
	if (value.length > RAW_ACCEPT_LIMIT) return { ok: false, issue: "TOO_LONG" };
	if (/https?:\/\//i.test(value) || /\bwww\./i.test(value)) {
		return { ok: false, issue: "CONTAINS_LINK" };
	}
	if (/["'`<>\\{}[\]]/.test(value)) return { ok: false, issue: "NOT_PLAIN_TEXT" };
	if (REFUSAL_MARKERS.some((marker) => value.toLowerCase().includes(marker))) {
		return { ok: false, issue: "REFUSAL" };
	}
	if (value.length < minLength) return { ok: false, issue: "TOO_SHORT" };
	if (value.length > maxLength) return { ok: false, issue: "TOO_LONG" };
	return { ok: true, value };
}

/** Convenience: normalize then validate in one step. */
export function describeOutput(
	raw: string,
	minLength: number,
	maxLength: number,
): ValidatedDescription {
	return validateDescription(normalizeDescription(raw, maxLength), minLength, maxLength);
}
