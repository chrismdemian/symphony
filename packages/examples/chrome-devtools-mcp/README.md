# chrome-devtools-mcp (example skeleton)

A Symphony **browser plugin** for
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
(Apache-2.0, official Google) — **interactive control of your live, logged-in
Chrome** over the Chrome DevTools Protocol. This is the "my actual session"
half of Symphony's browser stack; [Browserbase](../browserbase) is the "auth'd
cron in the cloud" half.

> **This is a Phase 9D SKELETON. It is non-functional.** Every tool returns a
> `SKELETON (Phase 9D)…` stub — no Chrome is ever touched. It exists to show
> the tool surface + manifest a real build uses and to document the **mandatory
> security envelope** below. Do **not** ship a real build without implementing
> the full envelope.

## Why this is the highest-risk surface in Symphony

CDP gives the agent **unrestricted access to every tab in your live Chrome** —
banking, password manager, work email, anything open. Chrome itself warns:

> *"any application on your machine can connect to this port and control the
> browser."*

Symphony does not relax that. It wraps it in a lock-down that is **mandatory,
not optional**. Most of it you get for free; the rest is the plugin's job.

## The full mandatory envelope

`plugin.json` declares `requires:host-browser-control`. That single flag makes
Symphony's host (`src/orchestrator/capabilities.ts`) enforce, with **zero code
in this plugin**:

| # | Guardrail | Enforced by |
|---|---|---|
| 1 | **Hardcoded EXACT Tier 3.** The autonomy dial cannot escape Tier 3 for this plugin — not "≥ 3", *exactly* 3 (there is no Tier 4). | host (`capabilities.ts` `tier !== 3`) |
| 2 | **Act-mode only.** Denied while Maestro is planning. | host (`mode !== 'act'`) |
| 3 | **Disabled in Away Mode** (Phase 3M). Confirms can't happen if you're not there. | host (`ctx.awayMode`) |
| 4 | **Cannot be an automation target** (Phase 8D). Scheduled/event-triggered runs may NOT call it — use Browserbase for cron-style auth'd browsing. | host (`ctx.automationContext`) |
| 5 | **Non-defeatable audit.** Every call that reaches the host — allowed or capability-denied — is logged to `~/.symphony/audit.log` **before** the tool runs (`tool_called` / `tool_denied`). | host (audit-before-dispatch) |
| 6 | **Disabled at install.** User must `symphony config plugins enable` (master switch) + enable this plugin. Default-deny. | host + install flow |

`irreversible` is also declared as belt-and-suspenders (a redundant Tier-3
floor).

The remaining guardrails the host **cannot** express generically — a real build
**must** implement them in this plugin's shim (the `EnvelopeGuard` contract in
`src/devtools.ts`):

| # | Guardrail | Plugin's responsibility |
|---|---|---|
| 7 | **Live-browser-intent gate.** Maestro only grants a worker these tools when the user message explicitly contains live-browser-intent ("use my browser", "in my logged-in Gmail", "click X in my tab"). Ambiguous → Maestro asks; never tacit. Spawning a CDP worker without intent is a **Critical** violation. | Maestro prompt + tool-grant logic |
| 8 | **Per-action confirm.** Each call surfaces a TUI confirm (tool, target URL, action summary, e.g. *"click 'Send' on https://mail.google.com"*). y/n only — **no "always allow", no batch confirm.** | `EnvelopeGuard.confirm` |
| 9 | **Non-shrinkable domain denylist.** Calls targeting banking / password-manager / 2FA domains are **rejected before the prompt**. The user may ADD to the list (`~/.symphony/config.json` `cdpMcp.denylist`) but can NEVER shrink the defaults (`DEFAULT_DOMAIN_DENYLIST` in `devtools.ts`). The rejection happens inside the plugin (after the host has audited the call), so a real build logs the rejection itself. | `EnvelopeGuard.assertAllowedDomain` |
| 10 | **Tab pinning.** On session open the user picks ONE tab; only that tab is drivable. Cross-tab access is blocked by intercepting CDP `Target.attachToTarget` for any other target. | `EnvelopeGuard.assertPinnedTarget` |
| 11 | **One-tap session opt-out.** A soft-red `stop CDP` indicator (red `#E06C75`) shows while a session is active; one keystroke kills it and disables the plugin for the rest of the session. | plugin shim + TUI |

**Recommended (not enforceable):** run a SEPARATE Chrome profile for CDP work
(`--user-data-dir=~/.symphony/chrome-cdp-profile` via a `symphony cdp-chrome`
helper) so the agent's browser isn't the one holding your banking tabs.

## Where this fits

Symphony has four browser surfaces; **do not conflate them**:

| Tool | Consumer | Runs | Sandbox |
|---|---|---|---|
| Playwright MCP | reviewer subagent | local Chrome | MCP scope |
| `dev-browser` | worker | local Chrome | QuickJS WASM |
| Browserbase | worker / Phase 8D automation | cloud Chrome | cloud isolation |
| **Chrome DevTools MCP** (this) | worker, interactive, per-action confirmed | local **LIVE** Chrome | **none — every tab exposed** |

## Install

```bash
pnpm --filter @symphony/plugin-chrome-devtools-mcp-example build
symphony plugin install packages/examples/chrome-devtools-mcp
symphony config plugins enable                          # master switch (default off)
symphony config plugins enable chrome-devtools-mcp      # explicit per-plugin opt-in
```

No `config.json` is needed — CDP reuses your live Chrome session; there is no
token and no network egress to a remote host (the `requires:host-browser-control`
capability is the boundary, not a `net:` permission).

## Tools (skeleton surface)

All return a `{ implemented: false }` stub today.

- `list_pages()` — list open tabs (for tab pinning).
- `navigate_page({ url })` — open a URL in the pinned tab.
- `click({ selector })` — click an element.
- `fill({ selector, value })` — type into a field.
- `take_screenshot()` — capture the pinned tab.
- `evaluate_script({ expression })` — run JS in the page.

## Implementing it for real

The contract is in `src/devtools.ts` (`ChromeDevToolsSession` + `EnvelopeGuard`,
every method throwing `NotImplementedError`). To ship a working plugin:

1. Spawn / proxy the official `chrome-devtools-mcp` server (it connects to your
   Chrome via `--autoConnect`, Chrome 144+).
2. Implement `EnvelopeGuard` — denylist check → per-action confirm → pinned-tab
   check — and run it **before** every proxied call.
3. Replace each tool handler's `skeleton(...)` with a guarded proxy call.
4. Wire the live-browser-intent gate (Maestro side) and the one-tap opt-out
   (TUI side).

You inherit guardrails #1–#6 automatically by declaring the capability flag.
Guardrails #7–#11 are **mandatory** and are yours to build — a real build that
omits any of them is not compliant with Symphony's browser-stack security
envelope (PLAN.md §Browser Stack).
