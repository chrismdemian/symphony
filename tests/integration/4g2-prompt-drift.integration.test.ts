/**
 * Phase 4G.2 — drift-lock between `audit-loop-constants.ts` UI-reviewer
 * constants and the regenerated Maestro UI-verification fragment.
 *
 * The Maestro v1 prompt's UI-verification section quotes the
 * `UI_REVIEWER_TASK_BRIEF_TEMPLATE` body in a blockquote. The drift-lock
 * test imports the constant + asserts the regenerated fragment
 * contains every static line. Mirrors the 4G.1 prompt-drift test +
 * the 4F.3 `DESIGN_MD_AUTO_LOAD_NOTE` lock.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_REVIEWER_TASK_BRIEF_TEMPLATE } from '../../src/orchestrator/audit-loop-constants.js';

function readFragment(name: string): string {
  return readFileSync(
    path.join(process.cwd(), 'research', 'prompts', 'fragments', name),
    'utf8',
  );
}

describe('Phase 4G.2 — UI reviewer task brief drift lock', () => {
  it('Maestro UI-verification fragment quotes the static lines of the template', () => {
    const fragment = readFragment('maestro-ui-verification.md');
    // The template has `{desktop_path}`, `{mobile_path}`, and
    // `{requirements}` placeholders; assert the SURROUNDING static
    // segments appear in the fragment so Maestro sees the rubric
    // verbatim.
    const staticLines = [
      'You are a skeptical UI reviewer for Symphony.',
      'Screenshots from the implementer\'s worktree',
      "Desktop (1280x720):",
      "Mobile  (390x844):",
      'Visual requirements:',
      'Grading rubric:',
      'Default assumption: the visual changes have NOT succeeded',
      'Describe exactly what you observe in each screenshot',
      'Actively search for evidence of failure',
      'Do NOT approve unless every requirement is met exactly',
      'standard 8-field JSON completion report',
    ];
    for (const line of staticLines) {
      // Sanity — make sure the line is actually in the constant.
      expect(UI_REVIEWER_TASK_BRIEF_TEMPLATE).toContain(line);
      // Then assert the fragment quotes it.
      expect(fragment).toContain(line);
    }
  });

  it('verify_ui is in Maestro ACT mode tool list', () => {
    const modeFragment = readFragment('maestro-mode-machine.md');
    expect(modeFragment).toContain('`verify_ui`');
  });

  it('maestro-ui-verification fragment references verify_ui by name', () => {
    const fragment = readFragment('maestro-ui-verification.md');
    expect(fragment).toContain('verify_ui(worker_id)');
    expect(fragment).toContain('reviewer ≠ writer');
  });
});
