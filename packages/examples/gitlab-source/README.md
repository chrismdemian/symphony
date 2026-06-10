# gitlab-source (example)

A Symphony **issue-source plugin** for GitLab. It repackages the in-tree GitLab
connector (Phase 8C.3) as an opt-in plugin using the `@symphony/plugin-sdk`
`provides.issueSource` contract — the host wraps its two tools into the same
ingest + writeback pipeline `sync_gitlab` uses.

- **Source:** `gitlab` (the `task_external_links.source` value + the
  `sync_gitlab` tool name).
- **Pull-only:** no `pollIntervalMs` — Maestro drives `sync_gitlab` on demand.
- **Coexistence:** the in-tree GitLab connector stays the regression-locked
  default. Installing + enabling this plugin makes the in-tree connector
  **yield** (no double `sync_gitlab`, no double writeback). Enabling the plugin
  also gives up GitLab's 8D automation triggers (the trigger engine runs in a
  different process than the plugin host) — pull `sync_gitlab` + writeback still
  work fully.

## Install

```bash
pnpm --filter @symphony/plugin-gitlab-source-example build
symphony plugin install packages/examples/gitlab-source
symphony config plugins enable        # master switch (default off)
```

Then create `~/.symphony/plugins/gitlab-source-example/config.json`:

```json
{
  "token": "glpat-...",
  "projects": ["my-group/my-project"],
  "siteUrl": "https://gitlab.example.com",
  "statusWriteback": { "completed": "Done — closed by Symphony." }
}
```

`siteUrl` is optional (defaults to `https://gitlab.com`); `projects` must list at
least one `group/project` path. Symphony's env allowlist strips every
`SYMPHONY_*` var from the plugin subprocess — the plugin reads its **own** token
from `config.json`, never Symphony's keychain. That isolation is the deliberate
cost of running as a plugin (and why coexistence defaults to the in-tree
connector).

## What it does

- `fetch_open_issues({ limit? })` — pulls open issues across the configured
  projects as `NormalizedIssue[]`, newest-updated first. Closed issues are
  flagged `isTerminal` so the host skips them. A token that can't see one
  project is skipped; the sync only fails when **every** project fails.
- `search_issues({ term, limit? })` — server-side search over title +
  description in each project.
- `write_back_status({ externalId, status })` — on task completion, adds a note
  (configured or a default) then closes the issue. `failed` adds a note only
  (never closes) and only when a note is configured.
- `check_connection()` — verifies the token.

## Notes

- Auth is the GitLab **personal access token** in the `PRIVATE-TOKEN` header
  (NOT `Authorization: Bearer` — that's OAuth).
- `externalId` is `group/project#iid` — the **per-project** issue number
  (`#42`), not GitLab's global issue id. Every writeback path needs the `iid`.
- List responses carry an `ETag`; single-project polls send `If-None-Match` and
  a `304 Not Modified` returns the cached issues. Multi-page fetches skip the
  cache (a page-1 304 can't prove later pages are unchanged).
- All GitLab calls funnel through a serialized throttle so a burst of task
  completions can't trip a rate limit.
