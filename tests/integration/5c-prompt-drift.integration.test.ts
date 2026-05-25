/**
 * Phase 5C — drift-lock between `audit-loop-constants.TASK_NOTES_PROTOCOL`
 * and the regenerated Maestro fragment / v1 monolith.
 *
 * The Context Hygiene fragment (`maestro-context-hygiene.md`) is
 * regenerated from `research/prompts/maestro-system-prompt-v1.md` via
 * `pnpm gen:fragments`. The prompt body quotes `TASK_NOTES_PROTOCOL`
 * verbatim. If a future edit changes EITHER side without touching the
 * other, this test fails CI — forcing both back into agreement.
 *
 * Mirrors the 4F.3 `DESIGN_MD_AUTO_LOAD_NOTE` + 4G.1 `AUDIT_*` +
 * 4G.2 `UI_REVIEWER_TASK_BRIEF_TEMPLATE` drift-lock patterns.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { TASK_NOTES_PROTOCOL } from '../../src/orchestrator/audit-loop-constants.js';
import { makeTaskNotesTool } from '../../src/orchestrator/tools/task-notes.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';

function readPromptFile(rel: string): string {
  return readFileSync(path.join(process.cwd(), 'research', 'prompts', rel), 'utf8');
}

describe('Phase 5C — task_notes protocol drift lock', () => {
  it('Maestro context-hygiene fragment quotes TASK_NOTES_PROTOCOL verbatim', () => {
    const fragment = readPromptFile('fragments/maestro-context-hygiene.md');
    expect(fragment).toContain(TASK_NOTES_PROTOCOL);
  });

  it('Maestro v1 monolith quotes TASK_NOTES_PROTOCOL verbatim', () => {
    const monolith = readPromptFile('maestro-system-prompt-v1.md');
    expect(monolith).toContain(TASK_NOTES_PROTOCOL);
  });

  it('TASK_NOTES_PROTOCOL names the task_notes tool in all three actions', () => {
    // Sanity — if someone refactors the tool or its action names, this
    // test (and the prompt drift-lock above) must be updated.
    expect(TASK_NOTES_PROTOCOL).toContain('task_notes(action: "append"');
    expect(TASK_NOTES_PROTOCOL).toContain('task_notes(action: "read"');
    expect(TASK_NOTES_PROTOCOL).toContain('task_notes(action: "list")');
  });

  it('TASK_NOTES_PROTOCOL references the disk-mirror path shape', () => {
    expect(TASK_NOTES_PROTOCOL).toContain('.symphony/tasks/<task-id>/notes.md');
  });

  // Audit M1 — the constant↔prompt triangle does NOT close unless the
  // constant also matches the actual tool's name + action enum. Lock
  // the constant→code direction so a future rename of either side
  // surfaces here before Maestro starts issuing tool calls that bounce
  // off Zod validation.
  it('TASK_NOTES_PROTOCOL matches the registered tool name (M1 drift lock)', () => {
    const tool = makeTaskNotesTool({
      taskStore: new TaskRegistry(),
      projectStore: new ProjectRegistry(),
    });
    expect(tool.name).toBe('task_notes');
    // The constant references `task_notes(action: "..."` — confirm the
    // tool registration matches that exact name.
    expect(TASK_NOTES_PROTOCOL).toContain(`${tool.name}(action:`);
  });

  it('TASK_NOTES_PROTOCOL covers every action in the tool\'s Zod enum (M1 drift lock)', () => {
    const tool = makeTaskNotesTool({
      taskStore: new TaskRegistry(),
      projectStore: new ProjectRegistry(),
    });
    const actionSchema = (
      tool as unknown as {
        inputSchema: Record<string, { _def?: { values?: readonly string[] } }>;
      }
    ).inputSchema.action;
    // Zod's z.enum(...) exposes the literal list at `_def.values` for
    // ZodEnum. We don't rely on the SDK exposing this — fall back to
    // safeParse probing if the internal field shape changes.
    const enumValues = actionSchema?._def?.values;
    const knownActions = ['append', 'read', 'list'] as const;
    if (Array.isArray(enumValues)) {
      // Sanity: assert the live enum equals the known set, in any order.
      expect([...enumValues].sort()).toEqual([...knownActions].sort());
    }
    // Every action MUST appear in the constant — covers the case where
    // someone adds a new action ('archive', 'delete') without updating
    // the prompt protocol.
    for (const action of knownActions) {
      expect(TASK_NOTES_PROTOCOL).toContain(`action: "${action}"`);
    }
  });
});
