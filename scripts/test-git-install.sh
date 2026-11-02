#!/usr/bin/env bash
# Integration proof for the private git-dependency contract
# (docs/private-git-dependency.md).
#
# Simulates what a consumer does when installing this repository as a pinned
# git dependency:
#
#   1. bare-clone the committed HEAD into a throwaway remote
#   2. create a fixture consumer with a strict build-script policy that
#      depends on `git+file://<remote>#<sha>`
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

echo "==> bare-cloning committed HEAD ($sha) to a throwaway remote"
git clone --quiet --bare "$repo_root" "$tmp/emdash-ai-helper.git"

echo "==> creating fixture consumer with strict build-script policy"
mkdir "$tmp/consumer"
cat >"$tmp/consumer/package.json" <<EOF
{
	"name": "emdash-ai-helper-git-install-fixture",
	"private": true,
	"type": "module",
	"dependencies": {
		"emdash-ai-helper": "git+file://$tmp/emdash-ai-helper.git#$sha"
	}
}
EOF
# Mirror a consumer that gates dependency build scripts, like Swissglam does.
cat >"$tmp/consumer/pnpm-workspace.yaml" <<'EOF'
strictDepBuilds: true
dangerouslyAllowAllBuilds: false
EOF

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

// Both bare imports resolve through the exports map of the *installed*
// package: "." -> dist/index.mjs, "./sandbox" -> dist/plugin.mjs.
const descriptor = (await import("emdash-ai-helper")).default;
assert.equal(descriptor.id, "emdash-ai-helper");
assert.equal(descriptor.entrypoint, "emdash-ai-helper/sandbox");
assert.deepEqual(
	new Set(descriptor.capabilities),
	new Set(["content:read", "content:write", "network:request"]),
);
const runtime = await import("emdash-ai-helper/sandbox");
assert.ok(runtime.default, "sandbox runtime must default-export the plugin");

// The built manifest must agree with the descriptor trust contract.
const pkgDist = dirname(await import.meta.resolve("emdash-ai-helper"));
const manifest = JSON.parse(
	readFileSync(join(pkgDist, "manifest.json"), "utf8"),
);
assert.equal(manifest.slug, "emdash-ai-helper");
assert.deepEqual(manifest.capabilities, descriptor.capabilities);
assert.deepEqual(new Set(manifest.allowedHosts), new Set(descriptor.allowedHosts));

console.log("descriptor + sandbox runtime + manifest loaded from the git-installed package");
EOF
( cd "$tmp/consumer" && node check.mjs )

echo "PASS: clean git clone + install + prepare + load all succeed"
