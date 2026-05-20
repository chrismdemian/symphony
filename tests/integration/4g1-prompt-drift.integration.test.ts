/**
 * Phase 4G.1 — drift-lock between `audit-loop-constants.ts` and the
 * regenerated Maestro fragment.
 *
 * The Audit Loop fragment (`research/prompts/fragments/maestro-audit-loop.md`)
 * is regenerated from `research/prompts/maestro-system-prompt-v1.md` via
 * `pnpm gen:fragments`. The prompt body quotes:
 *   - the `AUDIT_RESUME_PROMPT_PREFIX` line ("Reviewer audit returned FAIL.
 *     Findings:") verbatim,
 *   - the `AUDIT_RETRY_CAP` value in a substituted phrasing ("3 audit
 *     attempts have failed for this task."),
 *   - the `AUDIT_ESCALATION_TEMPLATE`'s static prefix ("How should I proceed?").
 *
 * The drift-lock tests below import each constant and assert the regenerated
 * fragment contains it. Mirrors the 4F.3 `DESIGN_MD_AUTO_LOAD_NOTE` M1 lock.
 *
 * If a future edit changes either the constant OR the v1 prompt without
 * touching the other, this test fails CI — forcing both sides into agreement.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ESCALATION_TEMPLATE,
  AUDIT_RESUME_PROMPT_PREFIX,
  AUDIT_RETRY_CAP,
} from '../../src/orchestrator/audit-loop-constants.js';

function readFragment(name: string): string {
  return readFileSync(
    path.join(process.cwd(), 'research', 'prompts', 'fragments', name),
    'utf8',
  );
}

describe('Phase 4G.1 — audit-loop constants drift lock', () => {
  it('Maestro prompt fragment quotes AUDIT_RESUME_PROMPT_PREFIX verbatim', () => {
    const fragment = readFragment('maestro-audit-loop.md');
    // The prefix ends in `\n` to lead the findings bullet block. The
    // fragment renders it as a blockquote, so the line content must
    // still appear verbatim inside the blockquote.
    const prefixFirstLine = AUDIT_RESUME_PROMPT_PREFIX.split('\n')[0]!;
    expect(fragment).toContain(prefixFirstLine);
  });

  it('Maestro prompt fragment mentions the AUDIT_RETRY_CAP value', () => {
    const fragment = readFragment('maestro-audit-loop.md');
    expect(fragment).toContain(`audit_attempts < ${AUDIT_RETRY_CAP}`);
    expect(fragment).toContain(`audit_attempts >= ${AUDIT_RETRY_CAP}`);
    expect(fragment).toContain(`${AUDIT_RETRY_CAP} audit attempts have failed`);
  });

  it('Maestro prompt fragment uses AUDIT_ESCALATION_TEMPLATE static segments', () => {
    const fragment = readFragment('maestro-audit-loop.md');
    // The template is `{attempts} audit attempts have failed for this task.
    // Latest findings:\n{findings}\nHow should I proceed?`. The prompt's
    // rendered escalation block contains the static segments between/around
    // the `{attempts}` / `{findings}` placeholders.
    // Segments: (1) ` audit attempts have failed for this task. Latest findings:`
    //           (2) `How should I proceed?`
    const middleSegment =
      AUDIT_ESCALATION_TEMPLATE.split('{attempts}')[1]!.split('{findings}')[0]!;
    expect(middleSegment.trim()).toBeTruthy();
    expect(fragment).toContain(middleSegment.trim());
    const suffix = AUDIT_ESCALATION_TEMPLATE.split('{findings}')[1]!.trim();
    expect(suffix).toBeTruthy();
    expect(fragment).toContain(suffix);
  });

  it('AUDIT_RETRY_CAP matches PLAN.md (3 attempts cap)', () => {
    // Sanity — if someone bumps the cap, the prompt + tests must adjust.
    expect(AUDIT_RETRY_CAP).toBe(3);
  });
});
