/**
 * Generation-record identity.
 *
 * One record exists per (collection, contentId, source text, model, length
 * contract) tuple, so republishing identical content never re-bills the
 * endpoint while an editor edit or a config change produces a fresh record.
 * The hook computes this id on every publish; tests use the same function to
 * seed or inspect records.
 */

import type { SourceText } from "./text.js";

export async function sha256Hex(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export interface GenerationRecordIdArgs {
	collection: string;
	contentId: string;
	source: SourceText;
	model: string;
	minLength: number;
	maxLength: number;
}

/** Deterministic record id for one generation contract. */
export async function generationRecordId(
	args: GenerationRecordIdArgs,
): Promise<string> {
	return sha256Hex(
		[
			args.collection,
			args.contentId,
			args.source.title,
			args.source.body,
			args.model,
			args.minLength,
			args.maxLength,
		].join("\u0000"),
	);
}
