import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

import { SKELETON_NOTICE } from './browserbase.js';

/**
 * browserbase — a Symphony BROWSER plugin SKELETON (Phase 9D).
 *
 * Browserbase is authenticated cloud Chrome: a worker (or a Phase 8D
 * automation) drives a remote browser that carries the user's cookies, so it
 * can act as authenticated-you on a SaaS dashboard the API doesn't cover
 * (Vercel, Cloudflare, Stripe, …). This is the "auth'd cron in the cloud"
 * half of Symphony's browser stack; the interactive "my actual live Chrome"
 * half is the chrome-devtools-mcp example.
 *
 * SECURITY ENVELOPE (declared in `plugin.json`, enforced by Symphony's host
 * via the EXISTING capability evaluator — you add ZERO enforcement code):
 *   - `requires:network-egress`  → Tier ≥2 (remote/cloud; cookies leave the box)
 *   - `requires:secrets-read`    → Tier ≥2 (reads a Browserbase API key)
 *   - `external-visible`         → Tier ≥2 (acts on external SaaS as the user)
 *   - `toolScope: "act"`         → tools exposed only in ACT mode
 *   - DISABLED at install        → user must `symphony config plugins enable`
 * Cost-aware: Browserbase bills per cloud action. Symphony's free local
 * Playwright (Phase 3 visual verification) and `dev-browser` (worker sandbox)
 * are NOT replaced by this — see README §Where this fits.
 *
 * THIS BUILD IS NON-FUNCTIONAL. Every handler returns `SKELETON_NOTICE`; no
 * Browserbase API is called. The real implementation contract is in
 * `browserbase.ts` + README.md. Diagnostics go to stderr; stdout is MCP.
 */

const skeleton = (detail: Record<string, unknown> = {}) => ({
  text: SKELETON_NOTICE,
  structuredContent: { implemented: false, ...detail },
});

await createPlugin({
  id: 'browserbase-example',
  name: 'Browserbase (example skeleton)',
  version: '0.1.0',
})
  .tool({
    name: 'create_session',
    description:
      'Create an authenticated cloud-Chrome session (optionally cookie-synced from local Chrome). SKELETON — returns a stub, no session is created.',
    inputSchema: {
      cookieSync: z
        .boolean()
        .optional()
        .describe('Import local Chrome cookies so the remote browser acts as authenticated-you. Cookies leave the machine.'),
    },
    permissions: ['secrets:read', 'net:*.browserbase.com'],
    handler: async () => skeleton({ tool: 'create_session' }),
  })
  .tool({
    name: 'navigate',
    description: 'Navigate the active session to a URL. SKELETON — no navigation occurs.',
    inputSchema: {
      url: z.string().url().describe('Absolute URL to open.'),
    },
    permissions: ['net:*.browserbase.com'],
    handler: async ({ url }) => skeleton({ tool: 'navigate', url }),
  })
  .tool({
    name: 'act',
    description:
      'Run a natural-language browser action on the active session (Stagehand `act`, e.g. "click the Deploy button"). SKELETON — no action is taken.',
    inputSchema: {
      instruction: z.string().min(1).describe('What to do, in plain language.'),
    },
    permissions: ['net:*.browserbase.com'],
    handler: async ({ instruction }) => skeleton({ tool: 'act', instruction }),
  })
  .tool({
    name: 'extract',
    description:
      'Extract structured data from the active page per an instruction (Stagehand `extract`). SKELETON — returns a stub, no data is read.',
    inputSchema: {
      instruction: z.string().min(1).describe('What to extract, in plain language.'),
    },
    permissions: ['net:*.browserbase.com'],
    handler: async ({ instruction }) => skeleton({ tool: 'extract', instruction }),
  })
  .tool({
    name: 'screenshot',
    description: 'Capture a screenshot of the active page (base64 PNG). SKELETON — returns a stub, no image is captured.',
    permissions: ['net:*.browserbase.com'],
    handler: async () => skeleton({ tool: 'screenshot' }),
  })
  .tool({
    name: 'close_session',
    description: 'Tear down the active cloud session (stops per-action billing). SKELETON — no session to close.',
    permissions: ['net:*.browserbase.com'],
    handler: async () => skeleton({ tool: 'close_session' }),
  })
  .serve();

process.stderr.write('[browserbase] serving — Phase 9D SKELETON (non-functional). See README.\n');
