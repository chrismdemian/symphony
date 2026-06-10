# forgejo-source (example)

A Symphony **issue-source plugin** for Forgejo (Gitea-compatible). It repackages
the in-tree Forgejo connector (Phase 8C.4) as an opt-in plugin using the
`@symphony/plugin-sdk` `provides.issueSource` contract — the host wraps its two
tools into the same ingest + writeback pipeline `sync_forgejo` uses.

- **Source:** `forgejo` (the `task_external_links.source` value + the
  `sync_forgejo` tool name).
- **Pull-only:** no `pollIntervalMs` — Maestro drives `sync_forgejo` on demand.
- **Coexistence:** the in-tree Forgejo connector stays the regression-locked
  default. Installing + enabling this plugin makes the in-tree connector
  **yield** (no double `sync_forgejo`, no double writeback). Enabling the plugin
  also gives up Forgejo's 8D automation triggers (the trigger engine runs in a
  different process than the plugin host) — pull `sync_forgejo` + writeback still
  work fully.

## Install

```bash
pnpm --filter @symphony/plugin-forgejo-source-example build
symphony plugin install packages/examples/forgejo-source
symphony config plugins enable        # master switch (default off)
```

Then create `~/.symphony/plugins/forgejo-source-example/config.json`:

```json
{
  "token": "...",
  "siteUrl": "https://code.acme.com",
  "repos": ["owner/repo"],
  "statusWriteback": { "completed": "Done — closed by Symphony." }
}
```

Forgejo is always self-hosted, so `siteUrl` is **required** (no default), and
`repos` must list at least one `owner/repo`. Symphony's env allowlist strips
every `SYMPHONY_*` var from the plugin subprocess — the plugin reads its **own**
token from `config.json`, never Symphony's keychain. That isolation is the
deliberate cost of running as a plugin (and why coexistence defaults to the
in-tree connector).

> The manifest declares `secrets:read` plus the `requires:network-egress`
> capability flag (uncontrolled egress) rather than a `net:<host>` host grant —
> a self-hosted Forgejo has no fixed host to scope to, so the egress is genuinely
> uncontrolled and the capability flag is the honest, enforceable declaration.

## What it does

- `fetch_open_issues({ limit? })` — pulls open issues across the configured
  repos as `NormalizedIssue[]`, newest-updated first. Pull requests are excluded
  (server-side `type=issues` plus a `pull_request`-field skip). Closed issues
  are flagged `isTerminal` so the host skips them. A token that can't see one
  repo is skipped; the sync only fails when **every** repo fails.
- `search_issues({ term, limit? })` — server-side search over title + body in
  each repo.
- `write_back_status({ externalId, status })` — on task completion, adds a
  comment (configured or a default) then closes the issue. `failed` adds a
  comment only (never closes) and only when a comment is configured.
- `check_connection()` — verifies the token.

## Notes

- Auth is the Forgejo **personal access token** in the `Authorization: token`
  header (the Gitea/Forgejo scheme — NOT `Authorization: Bearer`, which is OAuth).
- `externalId` is `owner/repo#number` — the **per-repo** issue number (Gitea's
  `index`), not the global issue id. Every writeback path needs the `number`.
- List responses carry an `ETag`; single-repo polls send `If-None-Match` and a
  `304 Not Modified` returns the cached issues. Multi-page fetches skip the
  cache (a page-1 304 can't prove later pages are unchanged).
- All Forgejo calls funnel through a serialized throttle so a burst of task
  completions can't trip a rate limit.
