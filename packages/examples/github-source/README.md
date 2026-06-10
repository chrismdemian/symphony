# github-source (example Symphony issue-source plugin)

The reference **issue-source** plugin. It pulls open GitHub issues into
Symphony as tasks and pushes terminal task status back to the issue
(comment + close on completion). It demonstrates the
`@symphony/plugin-sdk` `provides.issueSource` contract (Phase 9A).

## How it works

A plugin that declares `provides.issueSource` in its `plugin.json` stays a
pure MCP server. It exposes two tools the host calls:

- `fetch_open_issues({ limit? })` → `{ issues: NormalizedIssue[] }`
- `write_back_status({ externalId, status })` → `IssueWritebackResult`

(plus optional `search_issues` and `check_connection`).

Symphony's host wraps these in a `PluginIssueConnectorAdapter` and runs them
through the **same** ingest + writeback pipeline the in-tree connectors use:
it registers a `sync_github` MCP tool and a terminal-status writeback hook
backed by the shared `task_external_links` table. The host keeps owning the
TaskStore and the link table (single-writer); the plugin owns only the
GitHub I/O and its own secrets. There is **no plugin → host reverse
channel** — writeback is a host-initiated call to `write_back_status`.

## Configure

The plugin reads its token + repos from `config.json` in its install dir
(`~/.symphony/plugins/github-source-example/config.json`). Symphony's plugin
env allowlist strips every `SYMPHONY_*` var, so a plugin sources its own
secrets — never Symphony's keychain.

```json
{
  "token": "ghp_...",
  "repos": ["owner/repo", "owner/other-repo"],
  "completedComment": "Done — closed by Symphony.",
  "failedComment": "Symphony couldn't finish this; leaving it open."
}
```

`apiBaseUrl` (GitHub Enterprise) and `fetchLimit` are optional. `failedComment`
is optional — when omitted, a failed task is a writeback no-op (the issue is
never auto-closed on failure).

## Install + enable

```bash
pnpm --filter @symphony/plugin-github-source-example build
symphony plugin install packages/examples/github-source
symphony config plugins enable        # master switch (default off)
# then drop config.json into the install dir (see above)
```

When enabled, this plugin **takes over** the `github` source: Symphony's
in-tree GitHub connector yields, and `sync_github` is served by the plugin.
This is the coexistence model — in-tree is the default; installing + enabling
an issue-source plugin opts that source into the plugin path.

> Capability flags: `requires:secrets-read`, `requires:network-egress`,
> `external-visible` → the `sync_github` tool requires autonomy Tier ≥ 2.
