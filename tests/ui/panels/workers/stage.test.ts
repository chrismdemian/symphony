import { describe, it, expect } from 'vitest';
import {
  PIPELINE_STAGE_COUNT,
  roleToStage,
  stageLabelFor,
} from '../../../../src/ui/panels/workers/stage.js';
import { WORKER_ROLES, type WorkerRole } from '../../../../src/orchestrator/types.js';

describe('PIPELINE_STAGE_COUNT', () => {
  it('is 5 (Research → Plan → Implement → Test → Review)', () => {
    expect(PIPELINE_STAGE_COUNT).toBe(5);
  });
});

describe('roleToStage', () => {
  const cases: ReadonlyArray<[WorkerRole, number]> = [
    ['researcher', 0],
    ['planner', 1],
    ['implementer', 2],
    ['debugger', 3],
    ['reviewer', 4],
  ];
  for (const [role, expected] of cases) {
    it(`maps ${role} → stage index ${expected}`, () => {
      expect(roleToStage(role)).toBe(expected);
    });
  }

  it('covers every WorkerRole — no role falls outside [0..PIPELINE_STAGE_COUNT-1]', () => {
    for (const role of WORKER_ROLES) {
      const idx = roleToStage(role);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(PIPELINE_STAGE_COUNT);
    }
  });
});

describe('stageLabelFor', () => {
  const PAD = 12;
  const cases: ReadonlyArray<[WorkerRole, string]> = [
    ['researcher', 'Researching'],
    ['planner', 'Planning'],
    ['implementer', 'Implementing'],
    ['debugger', 'Debugging'],
    ['reviewer', 'Reviewing'],
  ];
  for (const [role, gerund] of cases) {
    it(`returns "${gerund}" padded to ${PAD} chars for ${role}`, () => {
      const label = stageLabelFor(role);
      expect(label.trim()).toBe(gerund);
      expect(label.length).toBe(PAD);
      expect(label.startsWith(gerund)).toBe(true);
    });
  }

  it('every WorkerRole produces a label of the same width', () => {
    const widths = WORKER_ROLES.map((r) => stageLabelFor(r).length);
    expect(new Set(widths).size).toBe(1);
  });
});
