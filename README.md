# EmDash AI Helper

A sandboxed EmDash plugin that writes a search-engine meta description from the
article text when an entry is published without one.

The plugin hooks into the publish workflow (`content:afterPublish`), flattens the
entry's title and body text, asks the configured AI endpoint for one description
in the entry's own language, validates the answer, and stores it on the entry.
Editors keep full control: a description typed by a human is never overwritten.

## How it behaves

- **Precedence.** If the entry's SEO panel already carries a description, the
  plugin does nothing and records `manual-description` in its diagnostics.
  The same re-check runs immediately before saving, so a description typed while
  a generation was in flight always wins.
- **Panel detection reads the schema, not the entry.** EmDash returns an entry's
  `seo` block only when that entry already has a SEO row, so a migrated post and
  a brand-new draft hand the plugin no block at all. A missing block is read as
  "no description yet" and generation proceeds; only the collection's own
  `hasSeo` flag (via `ctx.schema.getCollection`) can report the panel as
  disabled, and that is recorded as `seo-disabled`.
- **Publish safety.** Generation runs as deferred work after the publish
  transaction. A broken endpoint, a timeout, or a validation failure can never
  fail or roll back a publish; the entry stays live and the failure is recorded.
- **No duplicate billing.** Each (entry, source-text, model, length contract)
  combination is fingerprinted. A retry of the same publish reuses the previous
  result and sends nothing. Only failed attempts consume retry budget
  (configurable, default 3 attempts per text version, 1-hour cooldown).
- **Self-healing locks.** One in-flight generation per entry is enforced with a
  guard key. A guard or a `running` claim older than five minutes belongs to a
  hook instance that was hard-killed before it could release, so it is retaken
  on the next publish instead of suppressing that entry forever. The retake is
  a compare-and-delete on the stale revision: if another worker took the guard
  over in the meantime, the stale worker loses the race instead of deleting a
  live lease.
- **Explicit skip reasons.** Every path that ends without a request — guard
  held, guard race lost, already generated, retry cooldown, exhausted budget,
  run already claimed — writes an audit note and a log line naming the reason,
  so a silent skip is diagnosable.
- **No recursion.** The plugin registers only `content:afterPublish` and
  `page:metadata`. It never registers `content:beforeSave`/`content:afterSave`,
  and an SEO-only panel write does not run content save hooks.
- **No generation on public requests.** `page:metadata` reads plugin storage
  only. The AI endpoint is never called while a visitor loads a page.
- **Validated output.** Descriptions must be 70–160 characters (configurable),
  single-line, free of links, markup, and refusal boilerplate, and grounded only
  in the entry's text. Answers that overshoot are trimmed to a word boundary;
  answers that fail validation are discarded, not padded.

## Where the description is stored

The canonical target is the entry's SEO panel (`ctx.content.update` with an
`seo` payload). On EmDash 1.4.0 sandbox runners this write is rejected by the
host bridge (`Unknown field 'seo'`), so the plugin then keeps the description in
its own storage and serves it through the `page:metadata` hook as
`<meta name="description">`. That contribution fires only when the page carries
no description text of its own, so the site's and editors' descriptions always
take precedence — while a saved SEO row whose description is empty is not a
description and does not silence the fallback. When the SEO-panel write
succeeds, the fallback copy is removed.

The `diagnostics` admin route reports which channel is active
(`generated` vs. `generated:fallback`) per recent generation.

## Setup

1. Install the plugin package in your EmDash site and register it (the package
   is also consumable from a private git repository — see
   `docs/private-git-dependency.md`):

   ```ts
   // astro.config.mjs
   import emdashAiHelper from "emdash-ai-helper";

   export default defineConfig({
     integrations: [
       emdash({
         // ...
         sandboxed: [emdashAiHelper],
         sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox",
       }),
     ],
   });
   ```

2. In the EmDash admin, open the plugin's settings:

   | Setting | Default | Meaning |
   | --- | --- | --- |
   | Enabled | on | Master switch for generation |
   | Chat completions endpoint | `https://api.openai.com/v1/chat/completions` | HTTPS URL of an OpenAI-compatible endpoint (or a versioned base such as `.../v1`) |
   | Model | `gpt-4o-mini` | Model identifier passed to the endpoint |
   | API token | — | Secret, stored encrypted (see below) |
   | Minimum / maximum length | 70 / 160 | Description length contract |
   | Request timeout | 8000 ms | Per-request abort window (1000–20000 ms) |
   | Retries per entry | 3 | Attempt budget for transient failures (1–10) |

## Secret provisioning

The token is declared as a `secret` setting. EmDash stores it encrypted at rest
(AES-GCM envelope keyed by the site's `EMDASH_ENCRYPTION_KEY`). Keep that key in
your operational backups: a restored database without its keys cannot decrypt
stored tokens. The token is never exposed to the browser, never included in any
route response, log line, or diagnostic, and is sent only inside the
`Authorization: Bearer …` header of the configured endpoint request.

## Data transmitted to the AI endpoint

Each generation sends one HTTPS POST with:

- the entry's title and body text (plain text, markdown stripped, media and
  reference structures excluded, capped at ~12,000 characters);
- the entry locale (used to instruct the model to write in that language);
- the configured model name and small generation parameters.

It does **not** send: author identities, user accounts, comments, media, other
entries, or the secret token (which travels only in the `Authorization` header).

If your endpoint is hosted outside your region or run by a third party, that
provider receives the article text above. Use a self-hosted or contractually
covered endpoint if that matters for your content.

## Supported endpoints

The endpoint contract is the **OpenAI-compatible chat completions API**
(`POST { model, messages, temperature, max_tokens }` answered with
`{ choices: [{ message: { content } }] }`). The endpoint must be HTTPS, must not
embed credentials or a query string, and its host must be on the manifest's
declared allowlist:

`api.openai.com`, `api.groq.com`, `api.together.xyz`, `api.deepinfra.com`,
`api.fireworks.ai`, `api.mistral.ai`, `openrouter.ai`,
`generativelanguage.googleapis.com` (Gemini OpenAI-compatible endpoint).

To use another host, add it to `allowedHosts` in `emdash-plugin.jsonc` and to
`SUPPORTED_ENDPOINT_HOSTS` in `src/lib/config.ts`, and reinstall with the new
trust contract (host changes require renewed administrator consent).

## Admin routes

Both routes require the `plugins:manage` permission.

- `GET /_emdash/api/plugins/emdash-ai-helper/diagnostics[?collection=…&id=…]`
  — configuration summary (no secrets), the newest generation records, and, for
  a given entry, what the plugin sees in its SEO panel plus the state of its
  generation guard (`held`, timestamp, age, whether it is stale).
- `POST /_emdash/api/plugins/emdash-ai-helper/test-endpoint` — sends a fixed
  connectivity probe (no site content) and reports the mapped failure code.

## Failure semantics

| Condition | Behaviour |
| --- | --- |
| Editor wrote a description | Skipped, no request |
| No token / invalid endpoint / disabled | Skipped with a `config:*` diagnostic |
| Entry has no text to summarise | Skipped with an `empty-source` diagnostic |
| Collection has no SEO panel | Skipped with an `seo-disabled` diagnostic |
| Entry has no SEO row yet (migrated post, new draft) | Generated like any other empty description; the panel flag is read from the collection schema |
| SEO-panel write rejected by the host bridge | Description kept in plugin storage and served through `page:metadata`; an empty saved panel row does not silence that channel |
| A generation is already in flight | Skipped with a `generation-in-flight` diagnostic; stale guards (older than 5 minutes) are retaken |
| This source is already described / skipped / exhausted / cooling down | Skipped with the matching explicit diagnostic (`already-generated`, `previously-skipped`, `attempts-exhausted`, `retry-cooldown`) |
| Timeout or unreachable endpoint | Recorded; retried on a later publish within the attempt budget |
| HTTP 4xx (e.g. bad token, no quota) | Recorded; retried within the budget |
| HTTP 5xx | Recorded; retried within the budget |
| Output fails validation | Recorded; retried within the budget |
| Endpoint outage with exhausted budget | Entry stays live without a description; visible in diagnostics |

Diagnostics are readable in the EmDash server logs and through the
`diagnostics` route.

## Limitations

- Only entries in collections with the SEO panel enabled are described. A
  collection whose `hasSeo` flag cannot be read is treated as panel-enabled, so
  an unreadable schema never silently disables generation site-wide.
- One description per entry; regeneration happens only when the source text,
  model, or length contract changes.
- The generated text is as good as the configured model; the plugin validates
  form but cannot verify factual fidelity to the article beyond what the prompt
  constrains.
- Descriptions are generated in the entry's own locale; the endpoint must
  support that language.
- The SEO-panel fallback channel means the description may be served through
  the plugin rather than the panel on EmDash 1.4.0 sandbox runners.

## Development

```sh
pnpm install
pnpm run validate   # manifest check
pnpm run typecheck  # strict TypeScript
pnpm run test       # unit tests + sandboxed publish-lifecycle tests (workerd)
pnpm run build      # dist/plugin.mjs, dist/manifest.json, dist/index.mjs
pnpm run test:git-install  # prove the private git-dependency contract end to end
```

The `pnpm run test` suite is fully mocked: no real credentials are used and no
content is transmitted to any external service. The lifecycle tests run through
EmDash's production sandbox transport (`@emdash-cms/plugin-test`), including
user description precedence, empty entries, endpoint failures, output
validation, publish retries, and token-leak checks. The separate
`pnpm run test:git-install` integration check uses a temporary local git
remote, but it resolves build dependencies from the npm registry and therefore
requires network access; it uses no real GitHub credentials.

## Private distribution

This repository is private and is **not** published to the EmDash plugin
registry. See `docs/private-git-dependency.md` for the install and credential
contract, and `docs/release.md` for the tag-based release process.
