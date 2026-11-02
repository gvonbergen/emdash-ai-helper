# Release process

This package is distributed as a **private git dependency** (see
`docs/private-git-dependency.md`). It is never published to the EmDash plugin
registry and never published to npm, so releases are git tags.

## Cutting a release

1. Land the changes on the default branch through a reviewed pull request.
2. Bump `version` in `package.json` and add a `CHANGELOG.md` entry in the same
   pull request (keep `private: true` — it is a guard against accidental
   publication).
3. After merge, the maintainer creates an annotated tag on the merge commit:

   ```sh
   git tag -a v0.2.0 -m "emdash-ai-helper v0.2.0"
   git push origin v0.2.0
   ```

4. Consumers (for example Swissglam staging) move their git-dependency ref to
   the new tag (or a manually chosen commit SHA) in `package.json`, run
   `pnpm install` to regenerate `pnpm-lock.yaml`, and commit both files. pnpm
   keeps the declared ref in the manifest and records the commit it resolves in
   the lockfile; it does not rewrite a tag to a SHA. The refreshed lockfile
   is required before the consumer's frozen install can resolve the new ref
   and rebuild the package through `prepare`.

## Versioning rules

- Follow semver against the public surface the consumer uses: the default
  export descriptor (`dist/index.mjs`), the `./sandbox` export, the manifest
  trust contract (capabilities, allowedHosts, storage), and the admin routes.
- A changed trust contract (capabilities/allowedHosts/storage) is a minor bump
  at minimum; the consumer must reinstall so the new manifest is built and
  re-consented.
- `dist/` is never committed, so a release is always consumed by a clean
  `prepare` build — a tag guarantees a reproducible source state, and the
  artifact is built from exactly that source.

## History

- **0.2.0** — First git-dependency release: added the `prepare` script so the
  package builds `dist/` at install time, and documented private
  build-credential setup (`docs/private-git-dependency.md`).
- **0.1.0** — Initial plugin (sandboxed, not distributed as a git dependency).
