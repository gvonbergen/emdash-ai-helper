# Changelog

All notable changes to this package are documented here. The package is
distributed as a private git dependency (see `docs/release.md`); releases are
git tags.

## Unreleased

- Fixed the publish gate that skipped generation for every entry without a
  saved SEO row. EmDash returns an entry's `seo` block only when that entry
  already has a SEO row, so the old `seo === undefined` check read migrated
  posts and brand-new drafts as "SEO panel disabled" and never called the
  endpoint. A missing block is now read as an empty description and the
  collection's `hasSeo` schema flag decides, so entries with no row generate
  while collections genuinely without SEO keep the `seo-disabled` diagnostic.
  Manual-description precedence, the pre-write re-read, the duplicate-call
  guard, the retry budget, the diagnostics route, and every existing skip
  reason are unchanged; the canonical target stays the panel's meta
  description.
- The manifest declares the read-only `schema:read` capability to read that
  flag. Per `docs/release.md` a changed trust contract is a minor bump, so the
  consumer reinstalls and re-consents the manifest before the gate takes
  effect.

## 0.3.0

- Generation guards and `running` claims older than five minutes are treated as
  abandoned and retaken on the next publish, so one hard-killed hook instance
  can no longer suppress an entry forever.
- The `diagnostics` route reports the entry's generation guard (held, age,
  stale) next to the SEO-panel readback, still without any secret material.
- Every path that ends without a request now writes an audit note and a log
  line with an explicit reason (`generation-in-flight`, `guard-race-lost`,
  `claim-race-lost`, `already-generated`, `previously-skipped`,
  `run-in-progress`, `attempts-exhausted`, `retry-cooldown`).

## 0.2.0

- Added a `prepare` script (`emdash-plugin build`) so package managers that
  install this repository as a git dependency build `dist/` from source at
  install time. `dist/` stays gitignored; nothing generated is committed.
- Documented the private-install contract and the scoped build-credential
  setup for git-connected builds in `docs/private-git-dependency.md`.
- Documented the tag-based release process in `docs/release.md`.

## 0.1.0

- Initial plugin: generates a meta description on publish when the entry has
  none, with manual-description precedence, publish-safety guarantees,
  fingerprinted retries, and the SEO-panel fallback channel.
