import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { SKILL_MANIFEST, skillsDir } from './paths.js';
import { installSkill, listSkills } from './store.js';

/**
 * Phase 4D.4 — bundled skill set + idempotent first-run installer.
 *
 * The bundled SKILL.md docs are TEACHING content: they tell a worker
 * the Symphony-specific convention for each capability. The external
 * runtime installs they reference (`npm i -g dev-browser`,
 * `npx skills add vercel-labs/json-render`) are deliberately NOT run
 * here — auto-executing global installs on boot is an invasive side
 * effect. The user runs those once; the skill doc carries the
 * convention every worker needs.
 *
 * Idempotent: a present skill whose central `SKILL.md` already matches
 * the bundled content AND is linked into the agent dir is skipped, so
 * the first-run call is cheap on every subsequent boot.
 */

export interface BundledSkill {
  readonly id: string;
  readonly content: string;
}

const DEV_BROWSER_SKILL = `# dev-browser

Drive a real browser from worker code via Playwright running inside a
QuickJS WASM sandbox. No host filesystem or network access; file I/O is
scoped to \`~/.dev-browser/tmp/\`. A daemon keeps startup fast.

## When to use

Use this when a task needs to actually load a page, fill a form, click,
or read rendered DOM/console — not for the reviewer screenshot pass
(that is Symphony's separate Playwright MCP, owned by the reviewer
role). This is the WORKER sandbox; the two never mix.

## One-time setup (run on the host, not from a worker)

\`\`\`
npm i -g dev-browser && dev-browser install
\`\`\`

## Gotcha — local Chrome >= 147

If the host Chrome is version 147 or newer, the worker spawn env MUST
set \`PW_CHROMIUM_ATTACH_TO_OTHER=1\` or CDP attach hangs
(SawyerHood/dev-browser#103). Symphony sets this when it detects a
recent local Chrome; if you hit a CDP hang, that env var is the cause.

## Hard limits

The QuickJS WASM sandbox is hard isolation — do not try to extend it.
The only writable path is \`~/.dev-browser/tmp/\`.
`;

const JSON_RENDER_SKILL = `# json-render (Generative UI output)

Emit rich, structured output by writing a json-render spec in your
FINAL message — Symphony's TUI renders it. You run headless: you EMIT
specs, you never RENDER them. Do not import \`@json-render/ink\` or any
renderer; that line is enforced.

## How to use

When your result is tabular, multi-item status, or anything you would
otherwise hand-format as ASCII art, append one fenced block:

\`\`\`\`
\`\`\`json-render
{ "type": "Stack", "children": [
  { "type": "Heading", "text": "Summary" },
  { "type": "StatusLine", "label": "tests", "value": "142/142" }
] }
\`\`\`
\`\`\`\`

Use only the constrained catalog: \`Card\`, \`Stack\`, \`Heading\`,
\`StatusLine\`, \`Table\`, \`Text\`. No focusable/interactive components
(\`TextInput\`, \`Select\`, etc.) — the TUI renders specs read-only.

The \`display\` field of the completion report is advisory only: the
textual \`did\`/\`skipped\`/\`audit\` fields remain authoritative. A
malformed spec degrades to plain text; it never blocks the report.

## One-time setup (host/repo)

\`\`\`
npx skills add vercel-labs/json-render --skill ink
\`\`\`
`;

/** The v1 bundled set (PLAN.md §4D.4). Future candidates are out of scope. */
export const BUNDLED_SKILLS: readonly BundledSkill[] = [
  { id: 'dev-browser', content: DEV_BROWSER_SKILL },
  { id: 'json-render', content: JSON_RENDER_SKILL },
];

export interface BundledInstallResult {
  readonly installed: readonly string[];
  readonly skipped: readonly string[];
}

async function isCurrent(
  id: string,
  content: string,
  linkedIds: ReadonlySet<string>,
  home?: string,
): Promise<boolean> {
  if (!linkedIds.has(id)) return false;
  try {
    const onDisk = await fsp.readFile(
      path.join(skillsDir(home), id, SKILL_MANIFEST),
      'utf8',
    );
    return onDisk === content;
  } catch {
    return false;
  }
}

/**
 * Install (or refresh) every bundled skill. Idempotent: an
 * up-to-date + linked skill is skipped. `force` reinstalls regardless.
 */
export async function installBundledSkills(
  opts: { home?: string; force?: boolean } = {},
): Promise<BundledInstallResult> {
  const linkedIds = new Set(
    (await listSkills(opts.home)).filter((s) => s.linked).map((s) => s.id),
  );
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const skill of BUNDLED_SKILLS) {
    if (
      opts.force !== true &&
      (await isCurrent(skill.id, skill.content, linkedIds, opts.home))
    ) {
      skipped.push(skill.id);
      continue;
    }
    await installSkill({
      id: skill.id,
      content: skill.content,
      ...(opts.home !== undefined ? { home: opts.home } : {}),
    });
    installed.push(skill.id);
  }
  return { installed, skipped };
}
