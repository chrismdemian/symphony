# linear-source (example)

A Symphony **issue-source plugin** for Linear. It repackages the in-tree Linear
connector (Phase 8C) as an opt-in plugin using the `@symphony/plugin-sdk`
`provides.issueSource` contract — the host wraps its two tools into the same
ingest + writeback pipeline `sync_linear` uses.

- **Source:** `linear` (the `task_external_links.source` value + the
  `sync_linear` tool name).
- **Pull-only:** no `pollIntervalMs` — Maestro drives `sync_linear` on demand.
- **Coexistence:** the in-tree Linear connector stays the regression-locked
  default. Installing + enabling this plugin makes the in-tree connector
  **yield** (no double `sync_linear`, no double writeback).

## Install

```bash
pnpm --filter @symphony/plugin-linear-source-example build
symphony plugin install packages/examples/linear-source
symphony config plugins enable        # master switch (default off)
```

Then create `~/.symphony/plugins/linear-source-example/config.json`:

```json
{
  "token": "lin_api_...",
  "teamKey": "ENG",
  "statusWriteback": { "completed": "Done" }
}
```

Symphony's env allowlist strips every `SYMPHONY_*` var from the plugin
subprocess — the plugin reads its **own** API key from `config.json`, never
Symphony's keychain. That isolation is the deliberate cost of running as a
plugin (and why coexistence defaults to the in-tree connector).

## What it does

- `fetch_open_issues({ limit? })` — pulls the newest-updated issues (optionally
  scoped to `teamKey`) as `NormalizedIssue[]`. Issues in a terminal workflow
  state (`completed`/`canceled`) are flagged `isTerminal` so the host skips
  them. `limit` is clamped to Linear's hard cap of 250.
- `search_issues({ term, limit? })` — server-side full-text search.
- `write_back_status({ externalId, status })` — on task completion, moves the
  issue to the team's first `completed`-type workflow state (or the configured
  name). `failed` moves to a `canceled`-type state only when a name is
  configured.
- `check_connection()` — verifies the API key.

## Notes

- Auth is the Linear **personal API key** sent verbatim as the `Authorization`
  header (NO `Bearer` prefix — that's OAuth).
- `externalId` is Linear's internal issue **UUID** (`node.id`), not the
  human-readable `ENG-123` identifier — the UUID is the writeback target.
- All Linear calls funnel through a serialized throttle so a burst of task
  completions can't trip a rate limit.
