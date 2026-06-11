# @symphony/plugin-sdk

Author Symphony plugins with typed tools and event handlers instead of
hand-rolling an MCP server. A Symphony plugin is an MCP **server** over stdio;
this SDK wraps `@modelcontextprotocol/sdk` so you declare tools/events and call
`.serve()`. Symphony's host is the MCP **client** — it discovers your tools via
`listTools()`, re-registers each as a namespaced proxy behind its capability +
audit enforcement, and calls your `on_<event>` handlers when subscribed events
fire.

## Quick start

```ts
import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

await createPlugin({ id: 'my-plugin', name: 'My Plugin', version: '0.1.0' })
  .tool({
    name: 'greet',
    description: 'Return a greeting.',
    inputSchema: { who: z.string() },
    handler: ({ who }) => `Hello, ${who}!`,
  })
  .onTaskCompleted((e) => console.error(`task ${e.taskId} done`))
  .serve();
```

Pair it with a `plugin.json` manifest (`validateManifest` to check,
`defineManifest` to author) describing the spawn recipe + the security envelope
the user consents to at install. Tools are NOT listed in the manifest — they're
discovered at runtime via `listTools()`.

A plugin runs as a spawned subprocess with a **strict env allowlist**: Symphony
strips every `SYMPHONY_*` / `ANTHROPIC_*` / `AWS_*` var, so a plugin sources its
**own** secrets (e.g. from `<install-dir>/config.json`), never Symphony's
keychain. stdout is the MCP channel — write diagnostics to **stderr only**.

Build self-contained (`tsup` with `noExternal: ['@symphony/plugin-sdk',
'@modelcontextprotocol/sdk', 'zod']`) so the installed plugin runs from just
`plugin.json` + `dist/index.js`.

## Capability flags → autonomy tiers

A plugin declares `capabilityFlags` in its manifest. Symphony's host translates
them to its internal flags and gates **every** tool call by the current autonomy
tier — you add **zero** enforcement code; you inherit it by declaring the flag.

| Manifest flag | Enforcement |
|---|---|
| `requires:host-browser-control` | **EXACT Tier 3** + act-mode only + denied in Away Mode + denied from automations. The strictest gate; for live local-browser control. |
| `irreversible` | Tier ≥ 3. |
| `external-visible` | Tier ≥ 2. |
| `requires:secrets-read` | Tier ≥ 2 (first use at Tier 2 surfaces a one-time TUI notice). |
| `requires:network-egress` | Tier ≥ 2. |
| `requires:filesystem-write` | Recorded for install consent; no tier floor (OS-process isolation owns the filesystem boundary). |

`toolScope: "act"` (default) exposes a plugin's tools only in ACT mode; `"both"`
also exposes them while Maestro plans (for read-only plugins).

## Provider declarations

A plugin can declare it PROVIDES something beyond bare tools via `provides`:

- **`provides.issueSource`** — the host wraps the plugin's `fetch_open_issues` +
  `write_back_status` tools as an issue/task source and runs them through the
  same ingest + writeback pipeline the in-tree connectors use (`sync_<source>`,
  `task_external_links`). Optional `pollIntervalMs` makes the host poll on an
  interval. See any `*-source` example below.

## Examples

All live in [`../examples`](../examples). The `*-source` ones are bidirectional
**issue sources**; the two browser ones are **tool plugins** demonstrating the
security envelope.

### Issue sources (`provides.issueSource`)

| Example | Source | Notes |
|---|---|---|
| [`github-source`](../examples/github-source) | `github` | The dogfooded reference (Phase 9A). REST, ETag caching, PR filtering. |
| [`linear-source`](../examples/linear-source) | `linear` | GraphQL, raw-token auth, team-state writeback. |
| [`jira-source`](../examples/jira-source) | `jira` | `/search/jql`, ADF, comment + transition writeback. |
| [`gitlab-source`](../examples/gitlab-source) | `gitlab` | `PRIVATE-TOKEN`, `group/project#iid` ids, note + close. |
| [`forgejo-source`](../examples/forgejo-source) | `forgejo` | Gitea `token` auth, PR filtering, comment + close. |
| [`plain-source`](../examples/plain-source) | `plain` | GraphQL, internal note (never replyToThread) + markDone. |
| [`sentry-source`](../examples/sentry-source) | `sentry` | REST, token (not DSN), note-default + opt-in resolve. |
| [`notion-source`](../examples/notion-source) | `notion` | Data-sources API, host polling. |
| [`obsidian-source`](../examples/obsidian-source) | `obsidian` | Local vault scan, byte-preserving checkbox writeback. |

### Browser plugins (security-envelope examples)

| Example | Tier | Capability | What it shows |
|---|---|---|---|
| [`browserbase`](../examples/browserbase) | **2** | `requires:network-egress` | Authenticated **cloud** Chrome. Cost-aware, cookie-sync, pairs with Phase 8D automations. |
| [`chrome-devtools-mcp`](../examples/chrome-devtools-mcp) | **3** | `requires:host-browser-control` | Interactive control of your **live local** Chrome via CDP — the highest-risk surface. Carries the **full mandatory security envelope** (hardcoded Tier 3, away-disabled, automation-rejected, per-action confirm, non-shrinkable domain denylist, tab pinning, audit). |

> Both browser examples are **Phase 9D skeletons — non-functional**. Their
> handlers are stubs; their value is the manifest + the envelope documentation.
> Read each README before shipping a real build — the `chrome-devtools-mcp`
> envelope is **mandatory, not advisory**.

There is also a [`notifier`](../examples/notifier) example — an event-handler
plugin (no tools, subscribes to task/worker lifecycle events).

## API surface

- `createPlugin({ id, name, version })` → `PluginBuilder`
  - `.tool({ name, description, inputSchema?, permissions?, handler })` — chainable
  - `.onTaskCreated / onTaskCompleted / onTaskFailed / onWorkerSpawned / onWorkerCompleted(handler)`
  - `.serve(transport?)` — connect stdio (or a custom transport for tests)
- `validateManifest(input)` / `defineManifest(input)` — manifest schema
- `MANIFEST_CAPABILITY_FLAGS`, `PLUGIN_EVENTS`, `FIXED_PERMISSIONS`, `PLUGIN_API_VERSION`

The SDK's manifest schema is an independent duplicate of the host's, kept
byte-locked by a drift test (`tests/plugins/7b1-sdk-manifest-drift.unit.test.ts`).
