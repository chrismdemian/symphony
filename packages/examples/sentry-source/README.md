# sentry-source (example)

A Symphony **issue-source plugin** for [Sentry](https://sentry.io). It
repackages the in-tree Sentry connector (Phase 8D.5) as an opt-in plugin using
the `@symphony/plugin-sdk` `provides.issueSource` contract — the host wraps its
two tools into the same ingest + writeback pipeline `sync_sentry` uses.

- **Source:** `sentry` (the `task_external_links.source` value + the
  `sync_sentry` tool name).
- **Pull-only:** no `pollIntervalMs` — Maestro drives `sync_sentry` on demand.
- **Coexistence:** the in-tree Sentry connector stays the regression-locked
  default. Installing + enabling this plugin makes the in-tree connector
  **yield** (no double `sync_sentry`, no double writeback). Enabling the plugin
  also gives up Sentry's 8D `sentry_error` automation trigger — the trigger
  engine runs in a different process than the plugin host (it yields cleanly to
  `undefined`, never errors) — but pull `sync_sentry` + writeback still work
  fully.

## Install

```bash
pnpm --filter @symphony/plugin-sentry-source-example build
symphony plugin install packages/examples/sentry-source
symphony config plugins enable        # master switch (default off)
```

Then create `~/.symphony/plugins/sentry-source-example/config.json`:

```json
{
  "token": "sntrys_...",
  "org": "my-org",
  "projects": ["backend", "frontend"],
  "siteUrl": "https://us.sentry.io",
  "resolveOnCompleted": false,
  "statusWriteback": { "completed": "Investigated by Symphony." }
}
```

`token`, `org`, and at least one `projects` entry are required. `siteUrl`
defaults to `https://sentry.io`; set a region host (`https://us.sentry.io`) or a
self-hosted URL otherwise. Symphony's env allowlist strips every `SYMPHONY_*`
var from the plugin subprocess — the plugin reads its **own** token from
`config.json`, never Symphony's keychain. That isolation is the deliberate cost
of running as a plugin (and why coexistence defaults to the in-tree connector).

## What it does

- `fetch_open_issues({ limit? })` — pulls unresolved issues across the configured
  projects as `NormalizedIssue[]`, newest-first-seen. Resolved/ignored/muted
  issues are flagged `isTerminal` so the host skips them. A token that can't see
  one project is skipped; the sync only fails when **every** project fails.
- `search_issues({ term, limit? })` — server-side search
  (`query=is:unresolved <term>`) in each project.
- `write_back_status({ externalId, status })` — on task completion, posts an
  internal note (configured or a default) and resolves the issue **only** when
  `resolveOnCompleted` is set. `failed` posts a note only (never resolves, even
  with `resolveOnCompleted`) and only when a note is configured.
- `check_connection()` — verifies the token by listing one issue.

## Notes

- Auth is a Sentry **auth token** (scope `event:read`, + `event:write` for the
  opt-in resolve) in `Authorization: Bearer <token>` — **NOT a DSN** (a DSN is a
  write-only ingestion key).
- `externalId` is `<project>#<numericGroupId>`; writeback uses only the numeric
  group id + the configured org. The project routes to a Symphony project.
- The error `level` (`fatal`/`error`/`warning`/…) rides as a single pseudo-label
  so an automation trigger could scope by it (`--label fatal`) — Sentry has no
  real labels.
- List pagination follows the `Link` `rel="next"` cursor only while
  `results="true"` (Sentry always emits a `next` link). `statsPeriod=` is empty
  so a brand-new error isn't filtered out by the default 24h recency window.
- Investigating an error ≠ fixing it: `completed` resolves only when opted in,
  and `failed` never resolves — auto-resolving an unfixed error would hide a live
  production problem.
- All Sentry calls funnel through a serialized throttle so a burst of task
  completions can't trip a rate limit.
