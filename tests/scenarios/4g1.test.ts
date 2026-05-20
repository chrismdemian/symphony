/**
 * Phase 4G.1 production scenario — `audit_changes` MCP tool surfaces
 * `audit_attempts` to Maestro on every invocation; the counter advances
 * monotonically; store errors don't break the audit verdict.
 *
 * REAL `makeAuditChangesTool` + REAL `runAudit` + REAL `WorkerRegistry`
 * + REAL git temp repo with a staged change. Only the `claude -p`
 * reviewer subprocess is stubbed (the standard Track-1 boundary).
 *
 * Ground Truth Is Observable: assertions are on the MCP response's
 * structured_content + the in-memory counter on the WorkerRecord.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeAuditChangesTool } from '../../src/orchestrator/tools/audit-changes.js';
import type {
  OneShotRunner,
  OneShotResult,
} from '../../src/orchestrator/one-shot.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import { DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';

const execFileAsync = promisify(execFile);

function ctx(): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act' };
}

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

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-4g1-scenario-'));
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

/**
 * Scripted runner returning FAIL twice then PASS, mirroring the typical
 * Maestro iterate-in-place loop. Hand-shaped reviewer output exercises
 * the real `parseStructuredResponse` path.
 */
function scriptedRunner(): OneShotRunner {
  let call = 0;
  return async (_opts) => {
    call += 1;
    const verdict = call < 3 ? 'FAIL' : 'PASS';
    const findings =
      call < 3
        ? [
            {
              severity: 'Critical',
              location: 'feature.ts:1',
              description: 'missing test',
            },
          ]
        : [];
    const text = JSON.stringify({
      verdict,
      findings,
      summary: call < 3 ? 'feature.ts ships without a test' : 'all checks green',
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
  dir = await makeRepo();
  projectStore = new ProjectRegistry();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

interface MaybeStructured {
  readonly verdict?: 'PASS' | 'FAIL';
  readonly audit_attempts?: number;
}

describe('Phase 4G.1 scenario — audit_changes surfaces audit_attempts via MCP', () => {
  it('Section 1 — counter advances + surfaces in MCP response text + structured_content', async () => {
    const reg = new WorkerRegistry();
    registerWorker(reg, 'wk-loop', dir);
    const tool = makeAuditChangesTool({
      registry: reg,
      projectStore,
      oneShotRunner: scriptedRunner(),
    });

    const attempts: number[] = [];
    const verdicts: ('PASS' | 'FAIL' | undefined)[] = [];

    for (let i = 0; i < 3; i++) {
      const res = await tool.handler(
        {
          worker_id: 'wk-loop',
          model: undefined,
          base_ref: undefined,
          cap_bytes: undefined,
          timeout_ms: undefined,
        },
        ctx(),
      );
      const text = res.content
        .map((c) => ('text' in c ? c.text : ''))
        .join('');
      const struct = (res.structuredContent ?? {}) as MaybeStructured;
      attempts.push(struct.audit_attempts ?? -1);
      verdicts.push(struct.verdict);
      // Response text quotes the new counter on the `attempt:` line.
      expect(text).toContain(`attempt: ${i + 1}`);
    }

    expect(attempts).toEqual([1, 2, 3]);
    expect(verdicts).toEqual(['FAIL', 'FAIL', 'PASS']);
    expect(reg.get('wk-loop')?.auditAttempts).toBe(3);
  });

  it('Section 2 — store error does NOT break the audit; structured_content omits audit_attempts', async () => {
    const reg = new WorkerRegistry();
    registerWorker(reg, 'wk-err', dir);
    // Sabotage the bumpAuditAttempts seam to simulate a SQL write failure.
    reg.bumpAuditAttempts = (_id: string): number | undefined => {
      throw new Error('synthetic store failure');
    };

    const tool = makeAuditChangesTool({
      registry: reg,
      projectStore,
      oneShotRunner: scriptedRunner(),
    });
    const res = await tool.handler(
      {
        worker_id: 'wk-err',
        model: undefined,
        base_ref: undefined,
        cap_bytes: undefined,
        timeout_ms: undefined,
      },
      ctx(),
    );

    const struct = (res.structuredContent ?? {}) as MaybeStructured;
    // Verdict still flows through (audit is authoritative even if bump fails).
    expect(struct.verdict).toBe('FAIL');
    // audit_attempts is absent because the bump threw.
    expect(struct.audit_attempts).toBeUndefined();
    // isError reflects the audit verdict (FAIL → true), not the bump failure.
    expect(res.isError).toBe(true);
  });
});
