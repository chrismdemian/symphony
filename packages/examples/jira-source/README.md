# jira-source (example)

A Symphony **issue-source plugin** for Jira Cloud. It repackages the in-tree
Jira connector (Phase 8C.3) as an opt-in plugin using the `@symphony/plugin-sdk`
`provides.issueSource` contract — the host wraps its two tools into the same
ingest + writeback pipeline `sync_jira` uses.

- **Source:** `jira` (the `task_external_links.source` value + the `sync_jira`
  tool name).
- **Pull-only:** no `pollIntervalMs` — Maestro drives `sync_jira` on demand.
- **Coexistence:** the in-tree Jira connector stays the regression-locked
  default. Installing + enabling this plugin makes the in-tree connector
  **yield** (no double `sync_jira`, no double writeback).

## Install

```bash
pnpm --filter @symphony/plugin-jira-source-example build
symphony plugin install packages/examples/jira-source
symphony config plugins enable        # master switch (default off)
```

Then create `~/.symphony/plugins/jira-source-example/config.json`:

```json
{
  "token": "<atlassian-api-token>",
  "siteUrl": "https://acme.atlassian.net",
  "email": "you@acme.com",
  "projectKeys": ["ENG", "OPS"],
  "statusWriteback": { "completed": "Completed by Symphony." }
}
```

Symphony's env allowlist strips every `SYMPHONY_*` var from the plugin
subprocess — the plugin reads its **own** credentials from `config.json`, never
Symphony's keychain. That isolation is the deliberate cost of running as a
plugin (and why coexistence defaults to the in-tree connector).

## What it does

- `fetch_open_issues({ limit? })` — pulls open issues via a JQL fallback chain
  (configured `projectKeys` → `assignee = currentUser()` → `reporter` → a
  bounded `statusCategory != Done` catch-all → the issue-picker history). Issues
  already in a `Done` status category are flagged `isTerminal` so the host skips
  them.
- `search_issues({ term, limit? })` — JQL text search.
- `write_back_status({ externalId, status })` — on completion, posts a comment
  then transitions the issue to a Done-category state (`completedTransition`
  overrides which). `failed` posts a comment only when configured and **never**
  transitions — a failed task stays open for a human.
- `check_connection()` — verifies the credentials.

## Notes

- Auth is HTTP Basic `email:apiToken` (NOT a bearer token — that's OAuth). Both
  `siteUrl` and `email` are required.
- Fetch uses the enhanced-JQL endpoint `POST /rest/api/3/search/jql` (the legacy
  offset `search` endpoint was removed for Jira Cloud in 2025). It rejects
  fully-unbounded JQL, so every query is anchored on a real clause.
- `externalId` is the issue **key** (`ENG-123`). Descriptions are ADF; the
  plugin flattens them to plain text and posts comments back as ADF documents.
- A "commented but no Done transition available" outcome reports
  `written: false, code: not-found` so the host surfaces it — the comment landed
  but the issue couldn't be closed.
