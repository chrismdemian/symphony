# obsidian-source (example)

A Symphony **issue-source plugin** for an Obsidian vault. It repackages the
in-tree Obsidian connector (Phase 8B) as an opt-in plugin using the
`@symphony/plugin-sdk` `provides.issueSource` contract.

- **Source:** `obsidian` (the `task_external_links.source` value + the
  `sync_obsidian` tool name).
- **Polled, not watched:** the in-tree connector ran a live chokidar watcher.
  A sandboxed plugin can't push to the host, so the manifest declares
  `pollIntervalMs` (default 30 s) and the **host** polls `fetch_open_issues`
  on that cadence. Maestro can also call `sync_obsidian` on demand.
- **Coexistence:** the in-tree Obsidian connector stays the regression-locked
  default. Installing + enabling this plugin makes the in-tree connector
  **and its watcher** yield (no double source, no double writeback).

## Install

```bash
pnpm --filter @symphony/plugin-obsidian-source-example build
symphony plugin install packages/examples/obsidian-source
symphony config plugins enable        # master switch (default off)
```

Then create `~/.symphony/plugins/obsidian-source-example/config.json`:

```json
{
  "vaultPath": "/absolute/path/to/your/vault",
  "taskFormat": "auto",
  "projectProperty": "project",
  "statusWriteback": { "completed": "x", "appendDoneDate": true }
}
```

No token — a vault is a local folder. The plugin reads + writes the vault path
directly (Symphony's plugin sandbox is env-only, not fs-jailed).

## What it does

- `fetch_open_issues({ limit? })` — scans every `.md` file for Tasks-plugin
  checkboxes (`- [ ] do thing`), returning them as `NormalizedIssue[]`. Done
  (`[x]`) and cancelled (`[-]`) tasks are flagged `isTerminal` so the host
  skips them. Stable per-task locator: `🆔 id` → `^block-id` → content hash,
  with a within-file ordinal for identical lines.
- `write_back_status({ externalId, status })` — on task completion, flips the
  source checkbox to the configured char (default `x` + a `✅ YYYY-MM-DD`
  stamp), preserving every other byte in the file. `failed` only writes when a
  char is configured.
- `check_connection()` — verifies the vault path.

## Notes

- The host polls on `pollIntervalMs` (declared in `plugin.json`). Tune it by
  editing the installed plugin's `plugin.json` (5 s – 24 h). Polling is
  idempotent — re-scanning the same tasks just skips ones already linked.
- Writeback re-derives each line's locator from the same parse pass `fetch`
  uses, so it never touches frontmatter and survives edits elsewhere in the
  file. A task whose text you edit after import re-hashes its locator →
  writeback reports `not-found` (use a `🆔`/block id for a stable round-trip).
