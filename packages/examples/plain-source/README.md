# plain-source (example)

A Symphony **issue-source plugin** for [Plain](https://plain.com) (customer
support). It repackages the in-tree Plain connector (Phase 8C.4) as an opt-in
plugin using the `@symphony/plugin-sdk` `provides.issueSource` contract — the
host wraps its two tools into the same ingest + writeback pipeline `sync_plain`
uses.

- **Source:** `plain` (the `task_external_links.source` value + the `sync_plain`
  tool name).
- **Pull-only:** no `pollIntervalMs` — Maestro drives `sync_plain` on demand.
- **Coexistence:** the in-tree Plain connector stays the regression-locked
  default. Installing + enabling this plugin makes the in-tree connector
  **yield** (no double `sync_plain`, no double writeback). Enabling the plugin
  also gives up Plain's 8D automation triggers (`plain_thread`) — the trigger
  engine runs in a different process than the plugin host — but pull `sync_plain`
  + writeback still work fully.

## Install

```bash
pnpm --filter @symphony/plugin-plain-source-example build
symphony plugin install packages/examples/plain-source
symphony config plugins enable        # master switch (default off)
```

Then create `~/.symphony/plugins/plain-source-example/config.json`:

```json
{
  "token": "plainApiKey_...",
  "statuses": ["TODO", "SNOOZED"],
  "statusWriteback": { "completed": "Resolved by Symphony." }
}
```

Only `token` is required. `apiUrl` defaults to the UK region
(`https://core-api.uk.plain.com/graphql/v1`); set it for another region.
`statuses` defaults to `["TODO"]`. Symphony's env allowlist strips every
`SYMPHONY_*` var from the plugin subprocess — the plugin reads its **own** API
key from `config.json`, never Symphony's keychain. That isolation is the
deliberate cost of running as a plugin (and why coexistence defaults to the
in-tree connector).

## What it does

- `fetch_open_issues({ limit? })` — pulls threads in the configured statuses as
  `NormalizedIssue[]`, newest-created first. `DONE` threads are flagged
  `isTerminal` so the host skips them.
- `search_issues({ term, limit? })` — **client-side** text search over the
  thread title, ref, and preview (Plain has no server-side thread search), so it
  fetches a window then filters.
- `write_back_status({ externalId, status })` — on task completion, posts an
  **internal note** (configured or a default) then marks the thread done.
  `failed` posts an internal note only (never marks done) and only when a note is
  configured.
- `check_connection()` — verifies the API key by fetching the workspace.

## Notes

- Auth is the Plain **API key** in `Authorization: Bearer <key>`.
- Writeback is **internal-only**: `createNote` + `markThreadAsDone`. It NEVER
  uses `replyToThread`, which would email the customer.
- `createNote` requires the thread's `customerId`, so writeback first resolves it
  via a `thread(threadId)` lookup. A missing thread → `not-found` (Plain returns
  HTTP 200 for everything, so a null thread is the only not-found signal).
- `externalId` is the Plain thread `id`; `projectValue` is always `null` (Plain
  has no project concept — route via the `sync_plain` `project:` arg).
- Plain priority is inverted to Symphony's scale (urgent `0` → `3`, low `3` → `0`).
- All Plain calls funnel through a serialized throttle so a burst of task
  completions can't trip a rate limit.
