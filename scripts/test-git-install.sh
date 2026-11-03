#!/usr/bin/env bash
# Integration proof for the private git-dependency contract
# (docs/private-git-dependency.md).
#
# Simulates what a consumer does when installing this repository as a pinned
# git dependency:
#
#   1. materialize the committed HEAD in a throwaway bare remote
#   2. create a fixture consumer with a strict build-script policy that
#      depends on `git+file://<remote>#v0.2.0`
#   3. run a clean `pnpm install` (which must run our `prepare` script and
#      build dist/ from source)
#   4. assert the installed package is consumable: dist/ exists, src/ is not
#      shipped (npm-pack files semantics), and the descriptor, the runtime
#      module, and the manifest load and agree through the exports map.
#
# Run with `pnpm run test:git-install`. Requires network access (the fixture
# install resolves packages from the npm registry).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sha="$(git -C "$repo_root" rev-parse HEAD)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "==> materializing a clean remote from committed HEAD ($sha)"
# This checkout is a disposable git worktree, so it cannot serve as a clone
# source directly; a bundle carries the committed HEAD into a throwaway bare
# remote without touching anything outside this task.
git bundle create "$tmp/source.bundle" HEAD
git init --quiet --bare "$tmp/emdash-ai-helper.git"
git -C "$tmp/emdash-ai-helper.git" fetch --quiet "$tmp/source.bundle" "HEAD:refs/heads/task"
git -C "$tmp/emdash-ai-helper.git" symbolic-ref HEAD refs/heads/task
git -C "$tmp/emdash-ai-helper.git" tag v0.2.0 "$sha"

echo "==> creating fixture consumer with strict build-script policy"
mkdir "$tmp/consumer"
cat >"$tmp/consumer/package.json" <<EOF
{
	"name": "emdash-ai-helper-git-install-fixture",
	"private": true,
	"type": "module",
	"packageManager": "pnpm@12.16.1",
	"dependencies": {
		"emdash-ai-helper": "git+file://$tmp/emdash-ai-helper.git#v0.2.0"
	}
}
EOF
# Mirror a consumer that gates dependency build scripts (like Swissglam on
# pnpm 12 with strictDepBuilds does): the git dependency must be allowlisted
# by its hashless repository spec (bare package names do not match git deps).
cat >"$tmp/consumer/pnpm-workspace.yaml" <<EOF
strictDepBuilds: true
dangerouslyAllowAllBuilds: false
allowBuilds:
  "emdash-ai-helper@git+file://$tmp/emdash-ai-helper.git": true
EOF

expected_pnpm_version="12.16.1"
actual_pnpm_version="$(cd "$tmp/consumer" && pnpm --version)"
if [ "$actual_pnpm_version" != "$expected_pnpm_version" ]; then
	echo "FAIL: expected pnpm $expected_pnpm_version, got $actual_pnpm_version" >&2
	exit 1
fi

echo "==> running clean pnpm install (must run the dependency's prepare script)"
( cd "$tmp/consumer" && pnpm install )

pkg="$tmp/consumer/node_modules/emdash-ai-helper"

echo "==> asserting the installed package is consumable"
for artifact in index.mjs plugin.mjs manifest.json index.d.mts plugin.d.mts; do
	[ -f "$pkg/dist/$artifact" ] || {
		echo "FAIL: dist/$artifact missing after git install (prepare did not run?)" >&2
		exit 1
	}
done
[ -f "$pkg/emdash-plugin.jsonc" ] || { echo "FAIL: emdash-plugin.jsonc missing" >&2; exit 1; }
[ -d "$pkg/docs" ] || { echo "FAIL: docs/ missing from packed files" >&2; exit 1; }
[ ! -d "$pkg/src" ] || { echo "FAIL: src/ must not be shipped (files semantics)" >&2; exit 1; }
[ ! -d "$pkg/tests" ] || { echo "FAIL: tests/ must not be shipped (files semantics)" >&2; exit 1; }

echo "==> asserting the installed package loads in the fixture (bare imports)"
cat >"$tmp/consumer/check.mjs" <<'EOF'
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Both bare imports resolve through the exports map of the *installed*
// package: "." -> dist/index.mjs, "./sandbox" -> dist/plugin.mjs.
const descriptor = (await import("emdash-ai-helper")).default;
assert.equal(descriptor.id, "emdash-ai-helper");
assert.equal(descriptor.entrypoint, "emdash-ai-helper/sandbox");
assert.deepEqual(
	new Set(descriptor.capabilities),
	new Set(["content:read", "content:write", "schema:read", "network:request"]),
);
const runtime = await import("emdash-ai-helper/sandbox");
const plugin = runtime.default;
assert.ok(plugin, "sandbox runtime must default-export the plugin");
assert.deepEqual(Object.keys(plugin.hooks).sort(), ["content:afterPublish", "page:metadata"]);
const publishHook = plugin.hooks["content:afterPublish"];
assert.equal(typeof publishHook.handler, "function");
assert.equal(publishHook.errorPolicy, "continue");
assert.equal(typeof plugin.hooks["page:metadata"], "function");

let auditOutcome;
await publishHook.handler(
	{ collection: "posts", content: { id: "entry-1" } },
	{
		settings: { get: async () => null },
		storage: {
			audit: {
				put: async (_id, record) => {
					auditOutcome = record.outcome;
				},
			},
		},
		log: { warn: () => {} },
	},
);
assert.match(auditOutcome, /^config:/);

assert.deepEqual(Object.keys(plugin.routes).sort(), ["diagnostics", "test-endpoint"]);
for (const [name, methods] of [
	["diagnostics", ["GET"]],
	["test-endpoint", ["POST"]],
]) {
	const route = plugin.routes[name];
	assert.deepEqual(route.methods, methods);
	assert.equal(route.permission, "plugins:manage");
	assert.equal(typeof route.handler, "function");
}

const diagnostics = await plugin.routes.diagnostics.handler(
	{ input: {} },
	{
		settings: { get: async () => null },
		storage: {
			generations: { query: async () => ({ items: [], hasMore: false }) },
		},
	},
);
assert.equal(diagnostics.ok, true);
assert.equal(diagnostics.configured, false);
assert.deepEqual(diagnostics.recent, []);

const probe = await plugin.routes["test-endpoint"].handler(
	{},
	{ settings: { get: async () => null } },
);
assert.equal(probe.ok, false);

// The built manifest must agree with the descriptor trust contract.
const pkgDist = dirname(fileURLToPath(import.meta.resolve("emdash-ai-helper")));
const manifest = JSON.parse(
	readFileSync(join(pkgDist, "manifest.json"), "utf8"),
);
assert.equal(manifest.id, "emdash-ai-helper");
assert.deepEqual(manifest.capabilities, descriptor.capabilities);
assert.deepEqual(new Set(manifest.allowedHosts), new Set(descriptor.allowedHosts));

console.log("descriptor + sandbox runtime + manifest loaded from the git-installed package");
EOF
( cd "$tmp/consumer" && node check.mjs )

echo "PASS: clean git clone + install + prepare + load all succeed"
