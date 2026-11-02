import { describe, expect, it } from "vitest";

import { seoPanelSupported } from "../src/plugin.js";

/**
 * The plugin context slice the probe reads. Built structurally so each case
 * states exactly what the host exposes.
 */
type SchemaProbe = Parameters<typeof seoPanelSupported>[0];

function contextWithSchema(
	getCollection: (slug: string) => Promise<{ hasSeo: boolean } | null>,
): SchemaProbe {
	return { schema: { getCollection } } as unknown as SchemaProbe;
}

describe("seoPanelSupported: is the SEO panel available", () => {
	it("reports support when the collection declares hasSeo", async () => {
		const ctx = contextWithSchema(async () => ({ hasSeo: true }));
		expect(await seoPanelSupported(ctx, "posts")).toBe(true);
	});

	it("reports no panel when the collection declares hasSeo false", async () => {
		const ctx = contextWithSchema(async () => ({ hasSeo: false }));
		expect(await seoPanelSupported(ctx, "metrics")).toBe(false);
	});

	it("asks the schema about the collection it was given", async () => {
		const seen: string[] = [];
		const ctx = contextWithSchema(async (slug) => {
			seen.push(slug);
			return { hasSeo: true };
		});
		await seoPanelSupported(ctx, "posts");
		expect(seen).toEqual(["posts"]);
	});

	it("assumes a panel when the host exposes no schema access", async () => {
		// An older runner that does not grant `schema:read` must not turn the
		// gate back into "no seo block means no panel".
		expect(await seoPanelSupported({ schema: undefined }, "posts")).toBe(true);
	});

	it("assumes a panel when the schema lookup fails", async () => {
		const ctx = contextWithSchema(async () => {
			throw new Error("schema registry unavailable");
		});
		expect(await seoPanelSupported(ctx, "posts")).toBe(true);
	});

	it("assumes a panel for a collection the registry does not know", async () => {
		const ctx = contextWithSchema(async () => null);
		expect(await seoPanelSupported(ctx, "deleted-collection")).toBe(true);
	});
});
