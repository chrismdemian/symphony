import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeAuditChangesTool,
  runAudit,
} from '../../../src/orchestrator/tools/audit-changes.js';
import type { OneShotRunner, OneShotResult } from '../../../src/orchestrator/one-shot.js';
import { ProjectRegistry } from '../../../src/projects/registry.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../../src/orchestrator/worker-registry.js';
import type { StreamEvent, Worker } from '../../../src/workers/types.js';

const execFileAsync = promisify(execFile);

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    mode: 'act',
    tier: 2,
    awayMode: false,
    automationContext: false,
    ...overrides,
  };
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

async function makeTempRepoWithChange(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-audit-'));
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# base\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  // Add a change the auditor will see.
  await fs.writeFile(path.join(dir, 'feature.ts'), 'export const v = 1;\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  return dir;
}

function registerWorker(reg: WorkerRegistry, id: string, dir: string): void {
  const record: WorkerRecord = {
    id,
    projectPath: dir,
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
    detach: () => {},
  };
  reg.register(record);
}

function makeRunner(text: string): OneShotRunner {
  return async (_opts) => {
    const result: OneShotResult = {
      rawStdout: JSON.stringify({ result: text, session_id: 'sess-fake' }),
      text,
      sessionId: 'sess-fake',
      exitCode: 0,
      signaled: false,
      durationMs: 42,
      stderrTail: '',
    };
    return result;
  };
}

describe('runAudit', () => {
  let dir = '';
  let registry: WorkerRegistry;
  let projectStore: ProjectRegistry;

  beforeEach(async () => {
    dir = await makeTempRepoWithChange();
    registry = new WorkerRegistry();
    projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p', name: 'p', path: dir, createdAt: '' });
    registerWorker(registry, 'wk-1', dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns ok=true with PASS verdict from a clean response', async () => {
    const runner = makeRunner(
      JSON.stringify({
        verdict: 'PASS',
        findings: [{ severity: 'Minor', location: 'feature.ts:1', description: 'style nit' }],
        summary: 'Change looks correct.',
      }),
    );
    const r = await runAudit(
      { registry, projectStore, oneShotRunner: runner },
      { workerId: 'wk-1' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.verdict).toBe('PASS');
    expect(r.result.findings).toHaveLength(1);
    expect(r.result.summary).toContain('correct');
    expect(r.result.sessionId).toBe('sess-fake');
    expect(r.result.branch).toBe('main');
  });

  it('FAIL verdict is ok=true — the caller decides whether to stop', async () => {
    const runner = makeRunner(
      JSON.stringify({
        verdict: 'FAIL',
        findings: [{ severity: 'Critical', location: 'x.ts:1', description: 'null deref' }],
        summary: 'Critical bug found.',
      }),
    );
    const r = await runAudit(
      { registry, projectStore, oneShotRunner: runner },
      { workerId: 'wk-1' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.verdict).toBe('FAIL');
    expect(r.result.findings[0]?.severity).toBe('Critical');
  });

  it('returns ok=false when reviewer response lacks verdict/findings', async () => {
    const runner = makeRunner('totally unrelated text without any JSON');
    const r = await runAudit(
      { registry, projectStore, oneShotRunner: runner },
      { workerId: 'wk-1' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/valid verdict JSON/);
  });

  it('returns ok=false for unknown worker id', async () => {
    const runner = makeRunner('{}');
    const r = await runAudit(
      { registry, projectStore, oneShotRunner: runner },
      { workerId: 'wk-nope' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/Unknown worker/);
  });

  it('ignores malformed finding entries but keeps well-formed ones', async () => {
    const runner = makeRunner(
      JSON.stringify({
        verdict: 'PASS',
        findings: [
          { severity: 'Major', location: 'a.ts:1', description: 'ok' },
          { severity: 'Bogus', description: 'ignored' }, // wrong severity
          { description: '' }, // empty desc
          'not-even-an-object',
        ],
        summary: 's',
      }),
    );
    const r = await runAudit(
      { registry, projectStore, oneShotRunner: runner },
      { workerId: 'wk-1' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.findings).toHaveLength(1);
    expect(r.result.findings[0]?.description).toBe('ok');
  });

  it('propagates one-shot runner errors as ok=false', async () => {
    const runner: OneShotRunner = async () => {
      throw new Error('runner kaboom');
    };
    const r = await runAudit(
      { registry, projectStore, oneShotRunner: runner },
      { workerId: 'wk-1' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/runner kaboom/);
  });

  it('falls back to "(unregistered)" project when no matching path', async () => {
    // Register worker pointing at an unregistered path.
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'sym-audit-unreg-'));
    try {
      await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: other });
      await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: other });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd: other });
      await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: other });
      await fs.writeFile(path.join(other, 'a.md'), 'x\n', 'utf8');
      await execFileAsync('git', ['add', '.'], { cwd: other });
      await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: other });
      registerWorker(registry, 'wk-u', other);
      let capturedPrompt = '';
      const runner: OneShotRunner = async (opts) => {
        capturedPrompt = opts.prompt;
        return {
          rawStdout: '',
          text: JSON.stringify({ verdict: 'PASS', findings: [], summary: 'ok' }),
          exitCode: 0,
          signaled: false,
          durationMs: 1,
          stderrTail: '',
        };
      };
      const r = await runAudit(
        { registry, projectStore, oneShotRunner: runner },
        { workerId: 'wk-u' },
      );
      expect(r.ok).toBe(true);
      expect(capturedPrompt).toContain('(unregistered)');
    } finally {
      await fs.rm(other, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('audit_changes tool wrapper', () => {
  let dir = '';
  let registry: WorkerRegistry;
  let projectStore: ProjectRegistry;

  beforeEach(async () => {
    dir = await makeTempRepoWithChange();
    registry = new WorkerRegistry();
    projectStore = new ProjectRegistry();
    projectStore.register({ id: 'p', name: 'p', path: dir, createdAt: '' });
    registerWorker(registry, 'wk-1', dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('scope is act + no capability flags', () => {
    const tool = makeAuditChangesTool({
      registry,
      projectStore,
      oneShotRunner: makeRunner('{}'),
    });
    expect(tool.scope).toBe('act');
    expect(tool.capabilities).toEqual([]);
  });

  it('returns structuredContent + text + isError:false on PASS', async () => {
    const tool = makeAuditChangesTool({
      registry,
      projectStore,
      oneShotRunner: makeRunner(
        JSON.stringify({
          verdict: 'PASS',
          findings: [],
          summary: 'Looks fine.',
        }),
      ),
    });
    const r = await tool.handler(
      {
        worker_id: 'wk-1',
        model: undefined,
        base_ref: undefined,
        cap_bytes: undefined,
        timeout_ms: undefined,
      },
      ctx(),
    );
    expect(r.isError).toBe(false);
    expect(r.content[0]?.text).toContain('audit: PASS');
    expect(r.structuredContent?.verdict).toBe('PASS');
  });

  it('sets isError:true on FAIL verdict (Maestro treats it as meaningful error)', async () => {
    const tool = makeAuditChangesTool({
      registry,
      projectStore,
      oneShotRunner: makeRunner(
        JSON.stringify({
          verdict: 'FAIL',
          findings: [{ severity: 'Critical', location: 'x:1', description: 'no' }],
          summary: 'Critical.',
        }),
      ),
    });
    const r = await tool.handler(
      {
        worker_id: 'wk-1',
        model: undefined,
        base_ref: undefined,
        cap_bytes: undefined,
        timeout_ms: undefined,
      },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.verdict).toBe('FAIL');
  });

  it('returns isError:true with unknown-worker message', async () => {
    const tool = makeAuditChangesTool({
      registry,
      projectStore,
      oneShotRunner: makeRunner('{}'),
    });
    const r = await tool.handler(
      {
        worker_id: 'wk-nope',
        model: undefined,
        base_ref: undefined,
        cap_bytes: undefined,
        timeout_ms: undefined,
      },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Unknown worker/);
  });

  it('captures raw stdout tail when reviewer returns garbage', async () => {
    const garbage = 'this is not json at all '.repeat(100);
    const tool = makeAuditChangesTool({
      registry,
      projectStore,
      oneShotRunner: makeRunner(garbage),
    });
    const r = await tool.handler(
      {
        worker_id: 'wk-1',
        model: undefined,
        base_ref: undefined,
        cap_bytes: undefined,
        timeout_ms: undefined,
      },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.raw_stdout_tail).toBeDefined();
  });
});
