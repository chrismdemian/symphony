import { z } from 'zod';

/**
 * browserbase (example) — config + the implementation contract.
 *
 * This is a Phase 9D SKELETON. Nothing here talks to Browserbase; it exists
 * so a plugin author sees the SHAPE of a real implementation:
 *   - how config (incl. the API key) is read from `<install-dir>/config.json`,
 *   - the session/tool surface a real build would expose,
 *   - WHERE the real wiring goes (the `NOT_IMPLEMENTED` markers).
 *
 * To make it real, replace the stub methods with the Browserbase Node SDK
 * (`@browserbasehq/sdk` + `@browserbasehq/stagehand`) and the `cookie-sync`
 * skill (https://skills.sh/browserbase/skills/cookie-sync) so the remote
 * Chrome carries the user's authenticated cookies. The capability envelope
 * (Tier 2, `requires:network-egress`, `requires:secrets-read`) is already
 * declared in `plugin.json` and enforced by Symphony's host — you do NOT add
 * any enforcement code; you inherit it.
 */

/**
 * Config a real build reads from `<install-dir>/config.json`. The API key is
 * a SECRET the plugin sources itself — Symphony's env allowlist strips every
 * `SYMPHONY_*` var from the subprocess, so a plugin never reaches Symphony's
 * keychain (the deliberate cost of the sandbox; see README).
 */
export const BrowserbaseConfigSchema = z
  .object({
    /** Browserbase API key (https://www.browserbase.com/settings). */
    apiKey: z.string().min(1),
    /** Browserbase project id the sessions belong to. */
    projectId: z.string().min(1),
    /**
     * Opt-in: import the local Chrome cookie jar into the remote context so
     * the cloud browser acts as authenticated-you. Cookies LEAVE the machine
     * when true — the README calls this out as the medium-risk trade-off.
     */
    cookieSync: z.boolean().optional(),
    /** Override the API base (tests/self-hosted proxies). */
    apiUrl: z.string().url().optional(),
  })
  .strict();

export type BrowserbaseConfig = z.infer<typeof BrowserbaseConfigSchema>;

/** Thrown by every skeleton method — a real build replaces these. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(
      `${what} is a Phase 9D skeleton — not implemented. ` +
        'See packages/examples/browserbase/README.md for the implementation contract.',
    );
    this.name = 'NotImplementedError';
  }
}

/**
 * The contract a real `BrowserbaseSession` fulfils. Methods are documented but
 * unimplemented — they map 1:1 to the MCP tools in `index.ts`. A real build
 * makes each one drive the Browserbase SDK.
 */
export class BrowserbaseSession {
  constructor(_config: BrowserbaseConfig) {
    // A real build stores the SDK client + (lazily) the live session id here.
  }

  /** Create a cloud Chrome session (optionally cookie-synced). */
  create(): Promise<{ sessionId: string; connectUrl: string }> {
    throw new NotImplementedError('create_session');
  }

  /** Navigate the session to a URL. */
  navigate(_url: string): Promise<void> {
    throw new NotImplementedError('navigate');
  }

  /** Run a natural-language action (Stagehand `act`). */
  act(_instruction: string): Promise<void> {
    throw new NotImplementedError('act');
  }

  /** Extract structured data per an instruction/schema (Stagehand `extract`). */
  extract(_instruction: string): Promise<unknown> {
    throw new NotImplementedError('extract');
  }

  /** Capture a screenshot (base64 PNG) of the current page. */
  screenshot(): Promise<{ base64: string }> {
    throw new NotImplementedError('screenshot');
  }

  /** Tear the session down (releases the per-action cloud cost). */
  close(): Promise<void> {
    throw new NotImplementedError('close_session');
  }
}

/** The marker every skeleton tool returns so callers see it's a stub. */
export const SKELETON_NOTICE =
  'SKELETON (Phase 9D): browserbase is a non-functional example. This tool ' +
  'declares the security envelope + surface only. See the README to implement it.';
