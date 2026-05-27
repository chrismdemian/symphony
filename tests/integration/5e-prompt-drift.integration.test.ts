/**
 * Phase 5E — drift lock between `audit-loop-constants` saga constants,
 * the regenerated Maestro fragment `maestro-cross-project-saga.md`, the
 * v1 monolith, AND the live saga MCP tool surface (four tool names +
 * the `force_saga_partial` finalize input flag + the `saga-partial`
 * structured-content error code).
 *
 * The fragment is regenerated from
 * `research/prompts/maestro-system-prompt-v1.md` via `pnpm gen:fragments`.
 * If a future edit changes EITHER side without touching the other, this
 * test fails CI — forcing both back into agreement.
 *
 * Mirrors the 5D 4-way drift-lock pattern (constant ↔ fragment ↔
 * monolith ↔ tool name) with one extra direction for the finalize
 * input flag.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CROSS_PROJECT_SAGA_PROTOCOL,
  CROSS_PROJECT_SAGA_CREATION,
  CROSS_PROJECT_SAGA_MONITORING,
  CROSS_PROJECT_SAGA_GATE_RESPONSES,
  FORCE_SAGA_PARTIAL_FLAG_NAME,
  SAGA_PARTIAL_ERROR_CODE,
} from '../../src/orchestrator/audit-loop-constants.js';
import { makeCreateSagaTool } from '../../src/orchestrator/tools/create-saga.js';
import { makeUpdateSagaTool } from '../../src/orchestrator/tools/update-saga.js';
import { makeListSagasTool } from '../../src/orchestrator/tools/list-sagas.js';
import { makeGetSagaTool } from '../../src/orchestrator/tools/get-saga.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { SagaRegistry } from '../../src/state/saga-registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';

function readPromptFile(rel: string): string {
  return readFileSync(path.join(process.cwd(), 'research', 'prompts', rel), 'utf8');
}

describe('Phase 5E — cross-project saga protocol drift lock', () => {
  it('Maestro saga fragment quotes CROSS_PROJECT_SAGA_PROTOCOL verbatim', () => {
    const fragment = readPromptFile('fragments/maestro-cross-project-saga.md');
    expect(fragment).toContain(CROSS_PROJECT_SAGA_PROTOCOL);
  });

  it('Maestro v1 monolith quotes CROSS_PROJECT_SAGA_PROTOCOL verbatim', () => {
    const monolith = readPromptFile('maestro-system-prompt-v1.md');
    expect(monolith).toContain(CROSS_PROJECT_SAGA_PROTOCOL);
  });

  it('all four saga MCP tools are named verbatim in the fragment + monolith', () => {
    const fragment = readPromptFile('fragments/maestro-cross-project-saga.md');
    const monolith = readPromptFile('maestro-system-prompt-v1.md');
    for (const name of ['create_saga', 'update_saga', 'list_sagas', 'get_saga']) {
      expect(fragment).toContain(name);
      expect(monolith).toContain(name);
    }
  });

  it('saga MCP tool registrations match the names referenced in the prompt', () => {
    const projects = new ProjectRegistry();
    const sagas = new SagaRegistry();
    const tasks = new TaskRegistry();
    const create = makeCreateSagaTool({
      sagaStore: sagas,
      taskStore: tasks,
      projectStore: projects,
    });
    const update = makeUpdateSagaTool({ sagaStore: sagas });
    const list = makeListSagasTool({ sagaStore: sagas, projectStore: projects });
    const get = makeGetSagaTool({ sagaStore: sagas });

    expect(create.name).toBe('create_saga');
    expect(update.name).toBe('update_saga');
    expect(list.name).toBe('list_sagas');
    expect(get.name).toBe('get_saga');

    const fragment = readPromptFile('fragments/maestro-cross-project-saga.md');
    for (const tool of [create, update, list, get]) {
      // The fragment must reference the tool name (either directly or
      // in a call form `tool_name(...)` so Maestro can find it).
      expect(fragment).toContain(tool.name);
    }
  });

  it('force_saga_partial flag name matches finalize.ts schema (drift lock)', () => {
    // The fragment references the flag verbatim so Maestro doesn't
    // invent a different way to bypass the saga gate.
    const fragment = readPromptFile('fragments/maestro-cross-project-saga.md');
    expect(fragment).toContain(FORCE_SAGA_PARTIAL_FLAG_NAME);
    expect(FORCE_SAGA_PARTIAL_FLAG_NAME).toBe('force_saga_partial');
  });

  it('saga-partial error code is the verbatim string Maestro pattern-matches on', () => {
    // When Maestro reads the gate's structured-content `code`, it
    // checks for this exact string before surfacing the partial-merge
    // confirmation flow.
    expect(SAGA_PARTIAL_ERROR_CODE).toBe('saga-partial');
    const fragment = readPromptFile('fragments/maestro-cross-project-saga.md');
    expect(fragment).toContain(SAGA_PARTIAL_ERROR_CODE);
  });

  it('regenerated fragment manifest includes maestro-cross-project-saga.md', async () => {
    // The fragment file lands between active-project and voice in the
    // ordered manifest. Verify the file exists + is non-empty.
    const fragment = readPromptFile('fragments/maestro-cross-project-saga.md');
    expect(fragment.length).toBeGreaterThan(200);
    expect(fragment).toMatch(/^### Cross-Project Sagas/);
  });

  it('saga fragment immediate-neighbor sanity: active-project + voice still ship', () => {
    // The MAESTRO_FRAGMENT_FILES manifest places saga between
    // active-project and voice. Both neighbors must still exist (and the
    // generator already asserts file-count parity — if it doesn't,
    // gen:fragments would have failed before this test ran).
    const active = readPromptFile('fragments/maestro-active-project.md');
    const voice = readPromptFile('fragments/maestro-voice.md');
    expect(active.length).toBeGreaterThan(0);
    expect(voice.length).toBeGreaterThan(0);
  });

  /**
   * Post-audit M1 fix — `CROSS_PROJECT_SAGA_PROTOCOL` alone was a thin
   * section-header substring (~65 chars); the audit M1 finding showed
   * the load-bearing rules (creation conditions, monitoring, rollup
   * rules, default-to-waiting) could be silently rewritten without
   * the drift-lock noticing. The fix splits the protocol into four
   * constants — each one a verbatim substring of the fragment + v1
   * monolith — and locks every load-bearing token.
   */
  it('drift lock — CROSS_PROJECT_SAGA_CREATION block (verbatim)', () => {
    const fragment = readPromptFile('fragments/maestro-cross-project-saga.md');
    const monolith = readPromptFile('maestro-system-prompt-v1.md');
    expect(fragment).toContain(CROSS_PROJECT_SAGA_CREATION);
    expect(monolith).toContain(CROSS_PROJECT_SAGA_CREATION);
  });

  it('drift lock — CROSS_PROJECT_SAGA_MONITORING block (verbatim)', () => {
    const fragment = readPromptFile('fragments/maestro-cross-project-saga.md');
    const monolith = readPromptFile('maestro-system-prompt-v1.md');
    expect(fragment).toContain(CROSS_PROJECT_SAGA_MONITORING);
    expect(monolith).toContain(CROSS_PROJECT_SAGA_MONITORING);
  });

  it('drift lock — CROSS_PROJECT_SAGA_GATE_RESPONSES (default-to-waiting)', () => {
    // Post-audit M1: this constant locks the safety-critical "default
    // to waiting" + escape-hatch framing. A rewrite that flips the
    // default to "force partial" would fail this assertion.
    const fragment = readPromptFile('fragments/maestro-cross-project-saga.md');
    const monolith = readPromptFile('maestro-system-prompt-v1.md');
    expect(fragment).toContain(CROSS_PROJECT_SAGA_GATE_RESPONSES);
    expect(monolith).toContain(CROSS_PROJECT_SAGA_GATE_RESPONSES);
  });

  it('drift lock — load-bearing fragment tokens (immutability, rollup math)', () => {
    // Post-audit M1: belt-and-suspenders coverage. The four constants
    // above lock paragraph-level prose; this test locks the SHORT
    // load-bearing tokens that frame Maestro's decisions. If a future
    // edit drops e.g. `IMMUTABLE` from the membership rule, the
    // fragment loses an authoritative safety word — the test catches
    // it without requiring a constant rewrite for every token.
    const fragment = readPromptFile('fragments/maestro-cross-project-saga.md');
    const tokens = [
      'IMMUTABLE', // membership rule
      '`force_saga_partial', // bypass flag named verbatim
      'saga-partial', // structured-content code
      'rollup writer', // who's authoritative for completion
      'wait', // default response to partial gate
      'escape hatch', // characterizing force_saga_partial correctly
    ];
    for (const token of tokens) {
      expect(fragment).toContain(token);
    }
  });
});
