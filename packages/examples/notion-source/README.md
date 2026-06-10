# notion-source (example)

A Symphony **issue-source plugin** for Notion. It repackages the in-tree Notion
connector (Phase 8A) as an opt-in plugin using the `@symphony/plugin-sdk`
`provides.issueSource` contract — the host wraps its two tools into the same
ingest + writeback pipeline `sync_notion` uses.

- **Source:** `notion` (the `task_external_links.source` value + the
  `sync_notion` tool name).
- **Pull-only:** no `pollIntervalMs` — Maestro drives `sync_notion` on demand.
- **Coexistence:** the in-tree Notion connector stays the regression-locked
  default. Installing + enabling this plugin makes the in-tree connector
  **yield** (no double `sync_notion`, no double writeback).

## Install

```bash
pnpm --filter @symphony/plugin-notion-source-example build
symphony plugin install packages/examples/notion-source
symphony config plugins enable        # master switch (default off)
```

Then create `~/.symphony/plugins/notion-source-example/config.json`:

```json
{
  "token": "ntn_...",
  "databaseId": "<32-hex database id>",
  "statusProperty": "Status",
  "projectProperty": "Project",
  "priorityProperty": "Priority",
  "statusWriteback": { "completed": "Done" }
}
```

Symphony's env allowlist strips every `SYMPHONY_*` var from the plugin
subprocess — the plugin reads its **own** token from `config.json`, never
Symphony's keychain. That isolation is the deliberate cost of running as a
plugin (and why coexistence defaults to the in-tree connector).

## What it does

- `fetch_open_issues({ limit? })` — resolves the database's data source, queries
  pages (newest-edited first), and returns them as `NormalizedIssue[]`. Pages
  already in a terminal status (Done/Complete) are flagged `isTerminal` so the
  host skips them.
- `write_back_status({ externalId, status })` — on task completion, sets the
  page's status property to the configured value (`status` vs `select` shape is
  detected automatically). `failed` only writes when configured.
- `check_connection()` — verifies the token.

## Notes

- Notion API v5 is the "data sources" model: `databaseId` → `data_sources[0].id`
  → query the data source. Pin `dataSourceId` in `config.json` when a database
  exposes more than one.
- All Notion calls funnel through a serialized 3 req/s throttle so a burst of
  task completions can't trip a 429.
