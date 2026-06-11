/**
 * chrome-devtools-mcp (example) — the implementation contract + the envelope
 * a real build MUST honor.
 *
 * This is a Phase 9D SKELETON. Nothing here connects to Chrome; it documents
 * the shape of a real implementation and the guardrails it lives under.
 *
 * A real build proxies the official Google MCP server
 * (https://github.com/ChromeDevTools/chrome-devtools-mcp, Apache-2.0) which
 * connects to the user's running Chrome over the Chrome DevTools Protocol
 * (`--autoConnect`, Chrome 144+). That gives an agent UNRESTRICTED access to
 * EVERY tab in the user's live Chrome — banking, password manager, work email,
 * anything open. Chrome itself warns: "any application on your machine can
 * connect to this port and control the browser." Symphony does NOT relax that;
 * it wraps it in the mandatory envelope below.
 *
 * MOST of the envelope is enforced for free by Symphony's host the moment the
 * manifest declares `requires:host-browser-control`:
 *   - hardcoded EXACT Tier 3 (not "≥3" — there is no Tier 4),
 *   - act-mode only,
 *   - DENIED in Away Mode (Phase 3M),
 *   - DENIED from an automation context (Phase 8D),
 *   - audited before dispatch (non-defeatable),
 *   - default-deny at install (user must explicitly enable).
 * (`irreversible` adds a redundant Tier-3 floor as belt-and-suspenders.)
 *
 * A real build is responsible for the guardrails the host CANNOT express
 * generically — they live in THIS plugin's shim (the `EnvelopeGuard` contract):
 *   - per-action confirm prompt (no "always allow", no batch),
 *   - non-shrinkable domain denylist (banking / password managers / 2FA),
 *   - tab pinning (intercept CDP `Target.attachToTarget` for other targets),
 *   - one-tap session opt-out.
 * See README §The full mandatory envelope.
 */

/**
 * The default domain denylist a real build ships. The user may ADD to it
 * (`~/.symphony/config.json` `cdpMcp.denylist`) but can NEVER shrink it — a CDP
 * tool call targeting any of these is REJECTED before it reaches the per-action
 * prompt. This list is illustrative; a real build keeps it in sync with
 * PLAN.md §Browser Stack security envelope.
 */
export const DEFAULT_DOMAIN_DENYLIST: readonly string[] = [
  '*.bank.*',
  '*.banking.*',
  '*chase.com',
  '*wellsfargo.com',
  '*citi.com',
  '*revolut.com',
  '*coinbase.com',
  '*kraken.com',
  '*1password.com',
  '*bitwarden.com',
  '*lastpass.com',
  'accounts.google.com',
];

/** Thrown by every skeleton method — a real build replaces these. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(
      `${what} is a Phase 9D skeleton — not implemented. ` +
        'See packages/examples/chrome-devtools-mcp/README.md for the mandatory envelope.',
    );
    this.name = 'NotImplementedError';
  }
}

/**
 * The guardrails a real build MUST implement IN THE PLUGIN (the host can't do
 * them generically). Documented but unimplemented in the skeleton.
 */
export interface EnvelopeGuard {
  /** Reject targets matching the non-shrinkable denylist BEFORE the prompt. */
  assertAllowedDomain(url: string): void;
  /** Surface a per-action confirm (tool, target URL, action summary). y/n only. */
  confirm(summary: string): Promise<boolean>;
  /** Block cross-tab access — only the pinned target may be driven. */
  assertPinnedTarget(targetId: string): void;
}

/**
 * The contract a real CDP session fulfils — maps 1:1 to the MCP tools in
 * `index.ts`. Each real method runs `EnvelopeGuard` checks, THEN proxies the
 * official chrome-devtools-mcp tool.
 */
export class ChromeDevToolsSession {
  constructor(_guard?: EnvelopeGuard) {
    // A real build holds the proxied chrome-devtools-mcp client + the pinned
    // target id + the EnvelopeGuard here.
  }

  listPages(): Promise<Array<{ targetId: string; url: string; title: string }>> {
    throw new NotImplementedError('list_pages');
  }

  navigatePage(_url: string): Promise<void> {
    throw new NotImplementedError('navigate_page');
  }

  click(_selector: string): Promise<void> {
    throw new NotImplementedError('click');
  }

  fill(_selector: string, _value: string): Promise<void> {
    throw new NotImplementedError('fill');
  }

  takeScreenshot(): Promise<{ base64: string }> {
    throw new NotImplementedError('take_screenshot');
  }

  evaluateScript(_expression: string): Promise<unknown> {
    throw new NotImplementedError('evaluate_script');
  }
}

/** The marker every skeleton tool returns so callers see it's a stub. */
export const SKELETON_NOTICE =
  'SKELETON (Phase 9D): chrome-devtools-mcp is a non-functional example. This ' +
  'tool declares the mandatory security envelope + surface only. See the README ' +
  'before implementing it — this surface controls your LIVE logged-in Chrome.';
