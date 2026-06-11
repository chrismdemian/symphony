import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

import { SKELETON_NOTICE } from './devtools.js';

/**
 * chrome-devtools-mcp — a Symphony BROWSER plugin SKELETON (Phase 9D).
 *
 * Interactive control of the USER's LIVE logged-in Chrome over the Chrome
 * DevTools Protocol — the "my actual session" half of Symphony's browser stack
 * (Browserbase is the "auth'd cron in the cloud" half). A real build proxies
 * the official Google server
 * (https://github.com/ChromeDevTools/chrome-devtools-mcp).
 *
 * This is the HIGHEST-RISK surface in Symphony: CDP exposes EVERY tab in the
 * user's live Chrome. The full security envelope is MANDATORY (README). Most
 * of it is enforced FOR FREE by Symphony's host the moment `plugin.json`
 * declares `requires:host-browser-control`:
 *   - hardcoded EXACT Tier 3 (the autonomy dial CANNOT escape it),
 *   - act-mode only,
 *   - DENIED in Away Mode (Phase 3M — no user present to confirm),
 *   - DENIED from automations (Phase 8D — use Browserbase for auth'd cron),
 *   - audited to ~/.symphony/audit.log BEFORE dispatch (non-defeatable),
 *   - default-deny: `symphony config plugins enable` required.
 * The guardrails the host can't express generically (per-action confirm,
 * non-shrinkable domain denylist, tab pinning, one-tap opt-out) are the real
 * build's responsibility — see `devtools.ts` `EnvelopeGuard` + the README.
 *
 * THIS BUILD IS NON-FUNCTIONAL. Every handler returns `SKELETON_NOTICE`; no
 * Chrome is touched. Diagnostics go to stderr; stdout is the MCP channel.
 */

const skeleton = (detail: Record<string, unknown> = {}) => ({
  text: SKELETON_NOTICE,
  structuredContent: { implemented: false, ...detail },
});

await createPlugin({
  id: 'chrome-devtools-mcp-example',
  name: 'Chrome DevTools MCP (example skeleton)',
  version: '0.1.0',
})
  .tool({
    name: 'list_pages',
    description:
      "List the open tabs in the user's live Chrome (for tab pinning). SKELETON — returns a stub, no Chrome is queried.",
    handler: async () => skeleton({ tool: 'list_pages' }),
  })
  .tool({
    name: 'navigate_page',
    description:
      'Navigate the pinned tab to a URL. SKELETON — no navigation occurs. A real build rejects denylisted domains and prompts per-action first.',
    inputSchema: {
      url: z.string().url().describe('Absolute URL to open in the pinned tab.'),
    },
    handler: async ({ url }) => skeleton({ tool: 'navigate_page', url }),
  })
  .tool({
    name: 'click',
    description:
      'Click an element in the pinned tab. SKELETON — nothing is clicked. A real build surfaces a per-action confirm ("click \'Send\' on <url>").',
    inputSchema: {
      selector: z.string().min(1).describe('CSS selector / element id to click.'),
    },
    handler: async ({ selector }) => skeleton({ tool: 'click', selector }),
  })
  .tool({
    name: 'fill',
    description:
      'Type a value into a form field in the pinned tab. SKELETON — nothing is typed.',
    inputSchema: {
      selector: z.string().min(1).describe('CSS selector / element id of the field.'),
      value: z.string().describe('Text to enter.'),
    },
    // `value` is intentionally NOT echoed into structuredContent — a form fill
    // can carry sensitive text (passwords, tokens), which has no place in a
    // tool result a real build would also surface to the audit log.
    handler: async ({ selector }) => skeleton({ tool: 'fill', selector }),
  })
  .tool({
    name: 'take_screenshot',
    description: 'Capture a screenshot of the pinned tab (base64 PNG). SKELETON — returns a stub, no image is captured.',
    handler: async () => skeleton({ tool: 'take_screenshot' }),
  })
  .tool({
    name: 'evaluate_script',
    description:
      'Evaluate a JavaScript expression in the pinned tab and return its result. SKELETON — nothing is evaluated.',
    inputSchema: {
      expression: z.string().min(1).describe('JavaScript to evaluate in the page context.'),
    },
    handler: async () => skeleton({ tool: 'evaluate_script' }),
  })
  .serve();

process.stderr.write(
  '[chrome-devtools-mcp] serving — Phase 9D SKELETON (non-functional). See README before enabling a real build.\n',
);
