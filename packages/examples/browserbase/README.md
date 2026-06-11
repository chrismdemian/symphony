# browserbase (example skeleton)

A Symphony **browser plugin** for [Browserbase](https://www.browserbase.com) —
authenticated **cloud Chrome**. A worker (or a Phase 8D automation) drives a
remote browser that carries your cookies, so it can act as *authenticated-you*
on a SaaS dashboard the public API doesn't cover (Vercel, Cloudflare, Stripe…).

> **This is a Phase 9D SKELETON. It is non-functional.** Every tool returns a
> `SKELETON (Phase 9D)…` stub — no Browserbase API is ever called. It exists to
> (1) show the tool surface + manifest a real build uses, and (2) document the
> **mandatory security envelope**. To make it real, see
> [§Implementing it for real](#implementing-it-for-real).

- **Kind:** tool plugin (NOT an issue source — no `provides.issueSource`).
- **Tier:** **2** (Notify) minimum. The envelope below is enforced by Symphony's
  host through the *existing* capability evaluator — the plugin adds **zero**
  enforcement code; it inherits it by declaring the flags.

## Security envelope (mandatory)

Declared in `plugin.json`, enforced at every tool dispatch by
`src/orchestrator/capabilities.ts`:

| Capability flag | Floor | Why |
|---|---|---|
| `requires:network-egress` | Tier ≥ 2 | Remote/cloud browser; **cookies leave the machine** when `cookieSync` is on. |
| `requires:secrets-read` | Tier ≥ 2 | Reads a Browserbase API key from `config.json`. |
| `external-visible` | Tier ≥ 2 | Acts on external SaaS dashboards as the authenticated user. |

Plus:

- **`toolScope: "act"`** — the tools are exposed only while Maestro is in ACT
  mode, never while planning.
- **Disabled at install.** Symphony installs every plugin OFF. The user must
  run `symphony config plugins enable` (master switch) and enable this plugin.
- **Cost-aware.** Browserbase bills **per cloud action**. Symphony's free local
  Playwright (Phase 3 visual verification) and `dev-browser` (worker sandbox)
  are **not** replaced by this — see [§Where this fits](#where-this-fits).

At Tier 1 every tool is **denied**. At Tier ≥ 2 they're allowed (the first
secrets-read at Tier 2 surfaces a one-time first-use notice in the TUI).

## Where this fits

Symphony has four browser surfaces; **do not conflate them**:

| Tool | Consumer | Runs | Cost |
|---|---|---|---|
| Playwright MCP | reviewer subagent (visual verification) | local Chrome | free |
| `dev-browser` | worker, sandboxed (QuickJS WASM) | local Chrome | free |
| **Browserbase** (this) | worker / Phase 8D automation needing an **auth'd cloud** browser | cloud Chrome | per-action |
| Chrome DevTools MCP | worker needing your **live local** Chrome, interactively | local LIVE Chrome | free |

Browserbase pairs naturally with the Phase 8D Automation Framework — cron-style
tasks that need authenticated browser access without a human present (unlike
Chrome DevTools MCP, which requires user presence and **cannot** be an
automation target).

## Install

```bash
pnpm --filter @symphony/plugin-browserbase-example build
symphony plugin install packages/examples/browserbase
symphony config plugins enable          # master switch (default off)
```

Then create `~/.symphony/plugins/browserbase-example/config.json`:

```json
{
  "apiKey": "bb_live_...",
  "projectId": "...",
  "cookieSync": false
}
```

Symphony's env allowlist strips every `SYMPHONY_*` var from the plugin
subprocess — the plugin reads its **own** API key from `config.json`, never
Symphony's keychain. That isolation is the deliberate cost of running as a
plugin.

## Tools (skeleton surface)

All return a `{ implemented: false }` stub today.

- `create_session({ cookieSync? })` — open a cloud session (optionally
  cookie-synced so it's authenticated as you).
- `navigate({ url })` — open a URL in the session.
- `act({ instruction })` — run a natural-language action (Stagehand `act`).
- `extract({ instruction })` — pull structured data (Stagehand `extract`).
- `screenshot()` — capture the current page.
- `close_session()` — tear the session down (stops per-action billing).

## Implementing it for real

The contract lives in `src/browserbase.ts` (`BrowserbaseSession`, with every
method throwing `NotImplementedError`). To ship a working plugin:

1. Add `@browserbasehq/sdk` + `@browserbasehq/stagehand` as deps (keep
   `noExternal` so the bundle stays self-contained).
2. Implement `BrowserbaseSession` against the SDK; hold the live session id
   in-process (the plugin is one long-lived subprocess).
3. For `cookieSync`, import the local Chrome cookie jar into the remote context
   via the [`cookie-sync` skill](https://skills.sh/browserbase/skills/cookie-sync).
4. Replace each tool handler's `skeleton(...)` with a real call.

You do **not** add any tier/away/automation enforcement — the capability flags
in `plugin.json` already route every call through Symphony's host envelope.
