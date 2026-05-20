/**
 * Phase 4G.1 — full audit-loop iterate-in-place behavior.
 *
 * This test exercises the COMPLETE loop Maestro is supposed to run:
 *   1. audit FAIL → counter == 1
 *   2. (Maestro would call resume_worker here — we stub the implementer's
 *      "fix and re-run" by leaving the worktree state unchanged and just
 *      re-running audit)
 *   3. audit FAIL → counter == 2
 *   4. audit FAIL → counter == 3 → escalation point
 *
 * The counter survives across audits because both runs target the same
 * worker record. The cap is enforced by Maestro's prompt (the drift-lock
 * test pins the prompt text); this test confirms the counter mechanic
 * the prompt depends on.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../../src/orchestrator/tools/audit-changes.js';
import {
  AUDIT_RETRY_CAP,
} from '../../src/orchestrator/audit-loop-constants.js';
import type { OneShotRunner, OneShotResult } from '../../src/orchestrator/one-shot.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';

const execFileAsync = promisify(execFile);

function stubWorker(): Worker {
  return {
    id: 'wk',
    sessionId: undefined,
    status: 'completed',
    events: (async function* () {})(),
    sendFollowup: () => {},
    endInput: () => {},
    kill: () => {},
    waitForExit: async () =>
      ({ status: 'completed', exitCode: 0, signal: null, durationMs: 0 }),
  } as unknown as Worker;
}

async function makeTempRepoWithChange(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-4g1-loop-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# base\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'feature.ts'), 'export const v = 1;\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  return dir;
}

function registerWorker(reg: WorkerRegistry, id: string, dir: string): WorkerRecord {
  const record: WorkerRecord = {
    id,
    projectPath: dir,
    projectId: null,
    taskId: null,
    worktreePath: dir,
    role: 'implementer',
    featureIntent: 'ship feature v',
    taskDescription: 'implement feature v',
    autonomyTier: 2,
    dependsOn: [],
    status: 'completed',
    createdAt: new Date().toISOString(),
    worker: stubWorker(),
    buffer: new CircularBuffer<StreamEvent>(10),
    auditAttempts: 0,
    detach: () => {},
  };
  reg.register(record);
  return record;
}

function mixedSequenceRunner(): OneShotRunner {
  // Sequence: FAIL → PASS → FAIL → FAIL → FAIL. Locks the M2 invariant
  // that the cap reasons over CUMULATIVE attempts, not consecutive FAILs.
  let call = 0;
  return async (_opts) => {
    call += 1;
    const isPass = call === 2;
    const text = JSON.stringify({
      verdict: isPass ? 'PASS' : 'FAIL',
      findings: isPass
        ? []
        : [
            {
              severity: 'Critical',
              location: 'feature.ts:1',
              description: 'missing test',
            },
          ],
      summary: isPass ? 'looks clean' : 'no test',
    });
    const result: OneShotResult = {
      rawStdout: JSON.stringify({ result: text }),
      text,
      exitCode: 0,
      signaled: false,
      durationMs: 0,
      stderrTail: '',
    };
    return result;
  };
}

function failingRunner(): OneShotRunner {
  return async (_opts) => {
    const text = JSON.stringify({
      verdict: 'FAIL',
      findings: [
        {
          severity: 'Critical',
          location: 'feature.ts:1',
          description: 'missing test for new export',
        },
      ],
      summary: 'feature.ts ships without a test',
    });
    const result: OneShotResult = {
      rawStdout: JSON.stringify({ result: text }),
      text,
      exitCode: 0,
      signaled: false,
      durationMs: 0,
      stderrTail: '',
    };
    return result;
  };
}

let dir: string;
let projectStore: ProjectRegistry;

beforeEach(async () => {
  dir = await makeTempRepoWithChange();
  projectStore = new ProjectRegistry();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('Phase 4G.1 — full audit-loop iterate-in-place', () => {
  it('counter monotonically advances to the retry cap across consecutive FAILs', async () => {
    const reg = new WorkerRegistry();
    registerWorker(reg, 'wk-cap', dir);
    const deps = { registry: reg, projectStore, oneShotRunner: failingRunner() };

    const attempts: number[] = [];
    for (let i = 0; i < AUDIT_RETRY_CAP; i++) {
      const outcome = await runAudit(deps, { workerId: 'wk-cap' });
      if (!outcome.ok) throw new Error(`audit failed: ${outcome.message}`);
      expect(outcome.result.verdict).toBe('FAIL');
      attempts.push(outcome.result.auditAttempts ?? -1);
    }

    expect(attempts).toEqual([1, 2, 3]);
    expect(reg.get('wk-cap')?.auditAttempts).toBe(AUDIT_RETRY_CAP);
  });

  it('cumulative cap — counter does NOT reset on PASS (FAIL→PASS→FAIL→FAIL hits cap at attempt 4)', async () => {
    // Audit-fix M2: lock the "cumulative attempts, not consecutive FAILs"
    // semantics the prompt fragment + constants JSDoc document. Sequence:
    //   1. FAIL → counter 1
    //   2. PASS → counter 2 (no reset)
    //   3. FAIL → counter 3 (Maestro would escalate here — the cap is
    //      "audit_attempts >= AUDIT_RETRY_CAP", which now triggers even
    //      though only TWO real failures have occurred)
    const reg = new WorkerRegistry();
    registerWorker(reg, 'wk-mixed', dir);
    const deps = {
      registry: reg,
      projectStore,
      oneShotRunner: mixedSequenceRunner(),
    };

    const first = await runAudit(deps, { workerId: 'wk-mixed' });
    const second = await runAudit(deps, { workerId: 'wk-mixed' });
    const third = await runAudit(deps, { workerId: 'wk-mixed' });
    if (!first.ok || !second.ok || !third.ok) throw new Error('audit failed');

    expect(first.result.verdict).toBe('FAIL');
    expect(first.result.auditAttempts).toBe(1);

    expect(second.result.verdict).toBe('PASS');
    expect(second.result.auditAttempts).toBe(2); // NOT reset.

    expect(third.result.verdict).toBe('FAIL');
    expect(third.result.auditAttempts).toBe(AUDIT_RETRY_CAP);
    // Counter reaches the cap with only TWO real FAILs but THREE total
    // audit rounds — Maestro's prompt would escalate here.
  });

  it('a 4th audit after the cap continues to bump (Maestro applies the cap, not the server)', async () => {
    // The server tracks the count truthfully; Maestro's prompt decides
    // when to STOP. A 4th audit (Maestro disregarding the rule, USER
    // pushed it past, etc.) still bumps and returns the new count.
    const reg = new WorkerRegistry();
    registerWorker(reg, 'wk-past', dir);
    const deps = { registry: reg, projectStore, oneShotRunner: failingRunner() };

    for (let i = 0; i < AUDIT_RETRY_CAP; i++) {
      await runAudit(deps, { workerId: 'wk-past' });
    }
    const fourth = await runAudit(deps, { workerId: 'wk-past' });
    if (!fourth.ok) throw new Error('audit failed');
    expect(fourth.result.auditAttempts).toBe(AUDIT_RETRY_CAP + 1);
  });
});
