/**
 * Phase 5D — drift lock between `audit-loop-constants.ACTIVE_PROJECT_PROTOCOL`,
 * the regenerated Maestro fragment `maestro-active-project.md`, the v1
 * monolith, AND the live `set_active_project` MCP tool surface (name +
 * clear-sentinel).
 *
 * The Active Project Routing fragment is regenerated from
 * `research/prompts/maestro-system-prompt-v1.md` via `pnpm gen:fragments`.
 * The prompt body quotes `ACTIVE_PROJECT_PROTOCOL` verbatim. If a
 * future edit changes EITHER side without touching the other, this
 * test fails CI — forcing both back into agreement.
 *
 * Mirrors the 5C 4-way drift-lock pattern: constant ↔ fragment ↔
 * monolith ↔ tool name + Zod schema.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACTIVE_PROJECT_PROTOCOL } from '../../src/orchestrator/audit-loop-constants.js';
import {
  SET_ACTIVE_PROJECT_CLEAR_SENTINEL,
  makeSetActiveProjectTool,
} from '../../src/orchestrator/tools/set-active-project.js';
import { ProjectRegistry } from '../../src/projects/registry.js';

function readPromptFile(rel: string): string {
  return readFileSync(path.join(process.cwd(), 'research', 'prompts', rel), 'utf8');
}

describe('Phase 5D — active-project protocol drift lock', () => {
  it('Maestro active-project fragment quotes ACTIVE_PROJECT_PROTOCOL verbatim', () => {
    const fragment = readPromptFile('fragments/maestro-active-project.md');
    expect(fragment).toContain(ACTIVE_PROJECT_PROTOCOL);
  });

  it('Maestro v1 monolith quotes ACTIVE_PROJECT_PROTOCOL verbatim', () => {
    const monolith = readPromptFile('maestro-system-prompt-v1.md');
    expect(monolith).toContain(ACTIVE_PROJECT_PROTOCOL);
  });

  it('ACTIVE_PROJECT_PROTOCOL names the set_active_project tool verbatim', () => {
    // If a future rename touches one but not the other, surface it
    // here BEFORE Maestro starts issuing tool calls that bounce off
    // Zod validation.
    expect(ACTIVE_PROJECT_PROTOCOL).toContain('set_active_project(');
  });

  it('ACTIVE_PROJECT_PROTOCOL matches the registered tool name (drift lock)', () => {
    const tool = makeSetActiveProjectTool({
      projectStore: new ProjectRegistry(),
      setDispatchActiveProject: () => undefined,
      persist: async () => undefined,
    });
    expect(tool.name).toBe('set_active_project');
    expect(ACTIVE_PROJECT_PROTOCOL).toContain(`${tool.name}(`);
  });

  it('clear sentinel appears in both prompt sides verbatim', () => {
    // The protocol mentions `set_active_project("(none)")`; the
    // CLEAR_SENTINEL is the inner string. The fragment + monolith both
    // need to mention the exact tool-call shape so Maestro doesn't
    // invent a different way to clear.
    const fragment = readPromptFile('fragments/maestro-active-project.md');
    const monolith = readPromptFile('maestro-system-prompt-v1.md');
    const callForm = `set_active_project("${SET_ACTIVE_PROJECT_CLEAR_SENTINEL}")`;
    expect(fragment).toContain(callForm);
    expect(monolith).toContain(callForm);
  });

  it('Maestro v1 still references {project_name} + {registered_projects} after the insertion (regression)', () => {
    // Adding the new section between identity and voice MUST NOT drop
    // the boot-context tokens — Maestro reads them at session start.
    const monolith = readPromptFile('maestro-system-prompt-v1.md');
    expect(monolith).toContain('{project_name}');
    expect(monolith).toContain('{registered_projects}');
  });
});
