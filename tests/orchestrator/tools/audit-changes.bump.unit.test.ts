/**
 * Phase 4G.1 — `audit_changes` auto-bumps `WorkerRecord.auditAttempts`.
 *
 * Covers:
 *   - Counter bumps on PASS and FAIL alike.
 *   - `AuditResult.auditAttempts` reflects the post-bump value.
 *   - A store-error path (registry.bumpAuditAttempts throws) does NOT
 *     break the audit verdict — `auditAttempts` becomes `undefined`,
 *     the audit result is still authoritative.
 *
 * Mirrors the test rigging from `audit-changes.unit.test.ts`; uses
 * an in-memory `WorkerRegistry` (no store) so the counter lives in
 * memory only — sufficient to exercise the bump path.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../../../src/orchestrator/tools/audit-changes.js';
import type { OneShotRunner, OneShotResult } from '../../../src/orchestrator/one-shot.js';
import { ProjectRegistry } from '../../../src/projects/registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../../src/orchestrator/worker-registry.js';
import type { StreamEvent, Worker } from '../../../src/workers/types.js';

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-4g1-bump-'));
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

function passingRunner(): OneShotRunner {
  return async (_opts) => {
    const text = JSON.stringify({
      verdict: 'PASS',
      findings: [],
      summary: 'looks clean',
    });
    const result: OneShotResult = {
      rawStdout: JSON.stringify({ result: text, session_id: 'sess' }),
      text,
      sessionId: 'sess',
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
        { severity: 'Critical', location: 'feature.ts:1', description: 'missing test' },
      ],
      summary: 'no tests for feature.ts',
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

describe('Phase 4G.1 — audit_changes auto-bump', () => {
  it('bumps the counter on PASS and returns the new value', async () => {
    const reg = new WorkerRegistry();
    registerWorker(reg, 'wk-pass', dir);

    const outcome = await runAudit(
      { registry: reg, projectStore, oneShotRunner: passingRunner() },
      { workerId: 'wk-pass' },
    );

    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.message}`);
    expect(outcome.result.verdict).toBe('PASS');
    expect(outcome.result.auditAttempts).toBe(1);
    expect(reg.get('wk-pass')?.auditAttempts).toBe(1);
  });

  it('bumps the counter on FAIL and returns the new value', async () => {
    const reg = new WorkerRegistry();
    registerWorker(reg, 'wk-fail', dir);

    const outcome = await runAudit(
      { registry: reg, projectStore, oneShotRunner: failingRunner() },
      { workerId: 'wk-fail' },
    );

    if (!outcome.ok) throw new Error(`expected ok, got ${outcome.message}`);
    expect(outcome.result.verdict).toBe('FAIL');
    expect(outcome.result.auditAttempts).toBe(1);
    expect(reg.get('wk-fail')?.auditAttempts).toBe(1);
  });

  it('bumps cumulatively across consecutive audits on the same worker', async () => {
    const reg = new WorkerRegistry();
    registerWorker(reg, 'wk-loop', dir);

    const first = await runAudit(
      { registry: reg, projectStore, oneShotRunner: failingRunner() },
      { workerId: 'wk-loop' },
    );
    const second = await runAudit(
      { registry: reg, projectStore, oneShotRunner: failingRunner() },
      { workerId: 'wk-loop' },
    );
    const third = await runAudit(
      { registry: reg, projectStore, oneShotRunner: failingRunner() },
      { workerId: 'wk-loop' },
    );

    if (!first.ok || !second.ok || !third.ok) throw new Error('audit failed');
    expect(first.result.auditAttempts).toBe(1);
    expect(second.result.auditAttempts).toBe(2);
    expect(third.result.auditAttempts).toBe(3);
    expect(reg.get('wk-loop')?.auditAttempts).toBe(3);
  });

  it('does NOT reset the counter on PASS (monotonic per spec)', async () => {
    const reg = new WorkerRegistry();
    registerWorker(reg, 'wk-mono', dir);

    await runAudit(
      { registry: reg, projectStore, oneShotRunner: failingRunner() },
      { workerId: 'wk-mono' },
    );
    const passOutcome = await runAudit(
      { registry: reg, projectStore, oneShotRunner: passingRunner() },
      { workerId: 'wk-mono' },
    );

    if (!passOutcome.ok) throw new Error('expected ok');
    expect(passOutcome.result.verdict).toBe('PASS');
    expect(passOutcome.result.auditAttempts).toBe(2);
  });

  it('store error does NOT break the audit verdict', async () => {
    const reg = new WorkerRegistry();
    registerWorker(reg, 'wk-err', dir);
    // Sabotage bumpAuditAttempts so it throws.
    const original = reg.bumpAuditAttempts.bind(reg);
    reg.bumpAuditAttempts = (_id: string): number | undefined => {
      throw new Error('synthetic store failure');
    };

    const outcome = await runAudit(
      { registry: reg, projectStore, oneShotRunner: passingRunner() },
      { workerId: 'wk-err' },
    );

    if (!outcome.ok) throw new Error(`expected audit ok, got ${outcome.message}`);
    expect(outcome.result.verdict).toBe('PASS');
    // auditAttempts is undefined when the bump failed.
    expect(outcome.result.auditAttempts).toBeUndefined();

    // Restore so afterEach cleanup is happy (though reg is GC'd anyway).
    reg.bumpAuditAttempts = original;
  });
});
