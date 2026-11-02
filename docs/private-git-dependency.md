# Installing emdash-ai-helper as a private git dependency

This repository is **private and stays private**. It is deliberately **not
published to the EmDash plugin registry**: the `publisher` DID in
`emdash-plugin.jsonc` is a placeholder and must not be resolved for this
package. Consumers install it as a pinned git dependency instead.

## The git-dependency contract

`package.json` declares:

```json
"main": "dist/index.mjs",
"files": ["dist", "emdash-plugin.jsonc", "docs"],
"prepare": "emdash-plugin build"
```

- `dist/` is **gitignored** and is **never committed**. It is built from source
  at install time.
- Every package manager runs `prepare` when a package is installed through the
  git protocol (npm documents this contract; pnpm delegates git-hosted packages
  to npm internally). The `prepare` script installs this package's dev
  dependencies (`@emdash-cms/plugin-cli`) and then runs `emdash-plugin build`,
  producing `dist/index.mjs`, `dist/plugin.mjs`, `dist/manifest.json` and the
  type declarations.
- After `prepare`, the packer includes `dist/` (it is listed in `files`), so the
  installed package is importable exactly like a registry package.

A clean install therefore always consumes a freshly built artifact — there is no
opaque prebuilt bundle in git and no dist to keep in sync by hand.

Consumers that disable lifecycle scripts (`ignore-scripts=true`) break this
contract; keep script execution enabled for your install step.

### pnpm build-script gating

pnpm gates dependency lifecycle scripts. Verified behaviour:

- **pnpm 11.9.0** runs the git dependency's `prepare` without any allowlist
  entry — no extra configuration needed.
- **pnpm ≥ 12** with the default strict build policy
  (`strictDepBuilds`, as this repository itself uses) refuses with
  `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` until the dependency is allowlisted.
  For git-hosted packages the `allowBuilds` key must include the **package name
  and repository**, but must not include the tag or commit ref:

  ```yaml
  # pnpm-workspace.yaml of the consumer
  allowBuilds:
    "emdash-ai-helper@git+https://github.com/gvonbergen/emdash-ai-helper.git": true
  ```

  pnpm resolves the pinned tag or commit SHA before checking whether the git
  dependency may run `prepare`, and matches the hashless repository rule above.
  The same key therefore approves both tag and SHA pins; update it only when the
  repository URL changes.

## Pinned references

Pin the dependency to a **release tag** or an explicit commit SHA. Tags are cut
per the release process in `docs/release.md` (for example `v0.2.0`):

```jsonc
// package.json of the consumer
"emdash-ai-helper": "git+https://github.com/gvonbergen/emdash-ai-helper.git#v0.2.0"
```

Commit-SHA pins are equally valid when chosen manually. `pnpm update` keeps a
declared tag, branch, or version range in `package.json` and records the commit
it resolves in `pnpm-lock.yaml`; it does not rewrite the manifest to a SHA.
Whenever a pin changes, regenerate the consumer's `pnpm-lock.yaml` with
`pnpm install` and commit the updated lockfile before using
`--frozen-lockfile`.

## Build-time access to the private repository

Because the repository is private, any machine that runs the install — local
dev (your own GitHub credentials), CI, or a git-connected hosting build — must
be able to read **this repository only**. Do not embed a token in source, in the
lockfile, or in any committed file.

The supported, least-privilege setup is a **GitHub fine-grained personal access
token**:

1. GitHub → Settings → Developer settings → Fine-grained personal access tokens.
2. Repository access: **only `gvonbergen/emdash-ai-helper`** (no organization
   scope, no other repositories).
3. Permissions: **Contents: Read-only**. Nothing else.
4. Short expiry, tracked; rotate on schedule.

For **Cloudflare Workers Builds** (git-connected staging/production builds):

- Add the token as a **secret** under the Worker's *Settings → Build → Build
  variables and secrets*, for example `EMDASH_AI_HELPER_GITHUB_TOKEN`. Build
  secrets are build-only (not runtime) and are masked in build logs.
- The build must translate the secret into a git credential **at build time**
  and scoped to this one repository. Git's `insteadOf` rewrite is the mechanism;
  it never touches the lockfile URL, which stays the clean
  `https://github.com/gvonbergen/emdash-ai-helper.git` form.

  If the platform's automatic dependency install step runs before any custom
  command, set the build variable `SKIP_DEPENDENCY_INSTALL=true` and let the
  build command install dependencies itself, so the rewrite exists before
  `pnpm install` clones the dependency:

  ```sh
  git config --global \
    "url.https://x-access-token:${EMDASH_AI_HELPER_GITHUB_TOKEN}@github.com/gvonbergen/emdash-ai-helper.insteadOf" \
    'https://github.com/gvonbergen/emdash-ai-helper' \
  && pnpm install --frozen-lockfile \
  && pnpm build
  ```

  The rewrite is scoped to this repository's URL prefix; every other GitHub
  clone stays anonymous.

- Local development needs no dashboard setup: your existing GitHub SSH/HTTPS
  credentials already clone the private repository.

## What is deliberately not used

- **EmDash plugin registry** — publication is out of scope for this package;
  the manifest `publisher` stays a placeholder and must not be turned into a
  real DID for registry release.
- **Public repository** — the plugin source stays private.
- **Committed `dist/`** — generated output stays out of git; `prepare` builds it
  on the consumer side.
- **Vendored bundles in the consumer** — consumers depend on this repository, so
  plugin updates are a dependency bump, not a copy-paste.
- **Broad registry credentials** — the build token grants read access to this
  single repository and nothing else.
