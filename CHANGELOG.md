# Changelog

All notable changes to this package are documented here. The package is
distributed as a private git dependency (see `docs/release.md`); releases are
git tags.

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
