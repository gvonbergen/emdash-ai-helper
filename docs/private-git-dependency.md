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
- When this package is installed through the git protocol, pnpm prepares the
  dependency. This package requests pnpm 12.16.1, so pnpm installs the package's
  dev dependencies (`@emdash-cms/plugin-cli`) before invoking `prepare`. The
  `prepare` script itself only runs `emdash-plugin build`; it does not run
  another install, so the build-only contract does not reintroduce the removed
  recursive nested install. The build produces `dist/index.mjs`,
  `dist/plugin.mjs`, `dist/manifest.json` and the type declarations.
- After `prepare`, the packer includes `dist/` (it is listed in `files`), so the
  installed package is importable exactly like a registry package.

A clean install therefore always consumes a freshly built artifact — there is no
opaque prebuilt bundle in git and no dist to keep in sync by hand.

Consumers that disable lifecycle scripts (`ignore-scripts=true`) break this
contract; keep script execution enabled for your install step.

### pnpm build-script gating

pnpm gates dependency lifecycle scripts. A git-hosted dependency's `prepare`
requires explicit `allowBuilds` approval on every pnpm version listed below,
independently of `strictDepBuilds`. `strictDepBuilds` only controls how pnpm
treats other blocked dependency build scripts; it does not approve this
`prepare`. The accepted `allowBuilds` key depends on the pnpm version:

- **pnpm 11.9.0 and 11.10.0** require the exact full resolved commit in the
  key: `emdash-ai-helper@git+https://github.com/gvonbergen/emdash-ai-helper.git#<resolved-commit-sha>`.
- **pnpm 11.11.0 through 11.14.0** support repository-URL matching, so the
  hashless key `emdash-ai-helper@git+https://github.com/gvonbergen/emdash-ai-helper.git`
  is accepted.
- **pnpm 12.16.1** supports both that hashless repository key and the exact
  full resolved-SHA form. A tag-qualified key is not accepted because pnpm
  checks the resolved git artifact.

For the pinned pnpm 12.16.1, use this consumer configuration:

```yaml
# pnpm-workspace.yaml of the consumer
allowBuilds:
  "emdash-ai-helper@git+https://github.com/gvonbergen/emdash-ai-helper.git": true
```

pnpm resolves the pinned tag or commit SHA before checking whether the git
dependency may run `prepare`, and the hashless repository key therefore
approves both tag and SHA pins. Update the key only when the repository URL
changes.

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
    "url.https://x-access-token:${EMDASH_AI_HELPER_GITHUB_TOKEN}@github.com/gvonbergen/emdash-ai-helper.git.insteadOf" \
    'https://github.com/gvonbergen/emdash-ai-helper.git' \
  && pnpm install --frozen-lockfile \
  && pnpm build
  ```

  The rewrite applies only to URLs beginning with the exact `.git` repository
  URL, so consumers must use that URL form; other GitHub clones stay
  anonymous.

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
