// Vite resolves these imports through the transform pipeline, so the test
// works in every pool (forks and the sandboxed workerd test host alike).
import gitignore from "../.gitignore?raw";
import pkg from "../package.json";
import manifestSource from "../emdash-plugin.jsonc?raw";
import { describe, expect, it } from "vitest";

function parseJsonc(source: string): unknown {
	return JSON.parse(
		source
			.replace(/^\s*\/\/.*$/gm, "")
			.replace(/\/\*[\s\S]*?\*\//g, ""),
	);
}

describe("git-dependency packaging contract", () => {
	// docs/private-git-dependency.md: the package is installed as a private
	// git dependency, so `prepare` must build dist/ from source at install
	// time and the packer must ship the built artifacts.
	it("declares a prepare script that builds dist", () => {
		expect(pkg.scripts.prepare).toBe("emdash-plugin build");
		expect(pkg.files).toContain("dist");
		expect(pkg.files).toContain("emdash-plugin.jsonc");
	});

	it("keeps dist out of git so it is always built from source", () => {
		expect(gitignore.split("\n").map((line) => line.trim())).toContain("dist/");
	});

	it("stays private and unpinned to a registry publisher", () => {
		expect(pkg.private).toBe(true);
		// The registry publisher stays a placeholder: this package is never
		// published to the EmDash plugin registry.
		expect((parseJsonc(manifestSource) as { publisher: string }).publisher).toBe(
			"did:plc:replace-with-your-account-did",
		);
	});

	it("points every export at a dist artifact", () => {
		expect(pkg.exports["."].import).toBe("./dist/index.mjs");
		expect(pkg.exports["."].types).toBe("./dist/index.d.mts");
		expect(pkg.exports["./sandbox"]).toBe("./dist/plugin.mjs");
	});
});
