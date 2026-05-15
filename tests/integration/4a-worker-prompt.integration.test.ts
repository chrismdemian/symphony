import { describe, expect, it } from 'vitest';
import { createWorkerLifecycle } from '../../src/orchestrator/worker-lifecycle.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type {
  StreamEvent,
  Worker,
  WorkerConfig,
  WorkerExitInfo,
} from '../../src/workers/types.js';
import type { WorktreeManager } from '../../src/worktree/manager.js';
import type { CreateWorktreeOptions, WorktreeInfo } from '../../src/worktree/types.js';
import { WORKER_ROLES } from '../../src/orchestrator/types.js';

/**
 * Phase 4A integration — REAL `createWorkerLifecycle` + REAL
 * `WorkerRegistry` + the REAL frozen prompt artifacts on disk
 * (`research/prompts/`, no override). Only the lifecycle's OS boundary
 * (the `claude` subprocess via `WorkerManager`, git via
 * `WorktreeManager`) is stubbed — the documented integration pattern for
 * this project (2A.2 gotcha: "Integration-test fakes use REAL
 * createWorkerLifecycle with fake primitives").
 *
 * Asserts the observable ground truth: the exact first-message bytes
 * (`cfg.prompt`) the lifecycle hands the child carry the role opener,
 * the common suffix, the substituted vars, and the appended task.
 */

class StubWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: WorkerExitInfo['status'] = 'running';
  events: AsyncIterable<StreamEvent> = (async function* () {})();
  constructor(id: string) {
    this.id = id;
  }
  sendFollowup(): void {}
  endInput(): void {}
  kill(): void {}
  waitForExit(): Promise<WorkerExitInfo> {
    return new Promise(() => {});
  }
}

function makeWm(): { mgr: WorkerManager; configs: WorkerConfig[] } {
  const configs: WorkerConfig[] = [];
  const mgr = {
    spawn: async (cfg: WorkerConfig): Promise<Worker> => {
      configs.push(cfg);
      return new StubWorker(cfg.id);
    },
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
  return { mgr, configs };
}

function stubWt(): WorktreeManager {
  return {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => ({
      id: opts.workerId,
      path: `/wt/${opts.workerId}`,
      branch: `b/${opts.workerId}`,
      baseRef: 'refs/heads/main',
      projectPath: opts.projectPath,
      createdAt: '2026-05-15T00:00:00.000Z',
    }),
    list: async () => [],
    remove: async () => {},
    removeIfClean: async () => true,
    status: async () => ({
      hasChanges: false,
      staged: [],
      unstaged: [],
      untracked: [],
    }),
  } as unknown as WorktreeManager;
}

describe('Phase 4A integration — composed worker prompt reaches the child', () => {
  it('every role gets its opener + common suffix + appended task', async () => {
    for (const role of WORKER_ROLES) {
      const wm = makeWm();
      const lc = createWorkerLifecycle({
        registry: new WorkerRegistry(),
        workerManager: wm.mgr,
        worktreeManager: stubWt(),
      });
      await lc.spawn({
        id: `wk-${role}`,
        projectPath: '/home/chris/projects/symphony',
        taskDescription: `do the ${role} job`,
        role,
      });
      const prompt = wm.configs[0]?.prompt ?? '';
      // Role-differentiating opener (real frozen artifact text).
      expect(prompt).toContain('## Your Role:');
      // Common suffix's mandatory reporting contract.
      expect(prompt).toContain('### Reporting Format — MANDATORY');
      expect(prompt).toContain('"audit": "PASS"');
      // Appended task block, verbatim.
      expect(prompt).toContain(`# Your Task\n\ndo the ${role} job`);
      // Substituted spawn-time var actually referenced by the v1 suffix
      // (the stub worktree path). NOTE: `{project_name}` is declared in
      // the suffix's template-var header but NOT referenced in the v1
      // body — a reserved var (4D fragment expansion), so `projectName`
      // intentionally renders nowhere today.
      expect(prompt).toContain('/wt/wk-' + role);
      // No leaked template tokens or meta fences.
      expect(prompt).not.toContain('{worktree_path}');
      expect(prompt).not.toContain('## BEGIN SUFFIX');
      expect(prompt).not.toContain('Prepends to');
    }
  });

  it('researcher gets the read-only fence; reviewer gets the adversarial-auditor posture', async () => {
    const wmR = makeWm();
    const lcR = createWorkerLifecycle({
      registry: new WorkerRegistry(),
      workerManager: wmR.mgr,
      worktreeManager: stubWt(),
    });
    await lcR.spawn({
      id: 'wk-r',
      projectPath: '/p/proj',
      taskDescription: 'survey the auth module',
      role: 'researcher',
    });
    expect(wmR.configs[0]?.prompt).toContain('read-only investigator');

    const wmV = makeWm();
    const lcV = createWorkerLifecycle({
      registry: new WorkerRegistry(),
      workerManager: wmV.mgr,
      worktreeManager: stubWt(),
    });
    await lcV.spawn({
      id: 'wk-v',
      projectPath: '/p/proj',
      taskDescription: 'review the diff',
      role: 'reviewer',
    });
    expect(wmV.configs[0]?.prompt).toContain('Adversarial Auditor');
  });

  it('enumerates non-terminal sibling workers from the real registry', async () => {
    const wm = makeWm();
    const registry = new WorkerRegistry();
    const lc = createWorkerLifecycle({
      registry,
      workerManager: wm.mgr,
      worktreeManager: stubWt(),
    });
    await lc.spawn({
      id: 'wk-first',
      projectPath: '/p/proj',
      taskDescription: 'first task',
      role: 'implementer',
      featureIntent: 'the websocket one',
    });
    await lc.spawn({
      id: 'wk-second',
      projectPath: '/p/proj',
      taskDescription: 'second task',
      role: 'implementer',
      featureIntent: 'the play bar fix',
    });
    // Second worker's prompt should list the first as an in-flight sibling
    // and must NOT list itself.
    const second = wm.configs[1]?.prompt ?? '';
    expect(second).toContain('the websocket one');
    expect(second).toContain('/wt/wk-first');
    expect(second).not.toContain('the play bar fix — /wt/wk-second');
  });

  it('sources {test_cmd}/{build_cmd}/{lint_cmd} via resolveProjectCommands', async () => {
    const wm = makeWm();
    const lc = createWorkerLifecycle({
      registry: new WorkerRegistry(),
      workerManager: wm.mgr,
      worktreeManager: stubWt(),
      resolveProjectCommands: ({ projectPath }) => {
        expect(projectPath).toBe('/p/proj');
        return { test: 'pnpm test', build: 'pnpm build', lint: 'pnpm lint' };
      },
    });
    await lc.spawn({
      id: 'wk-cmds',
      projectPath: '/p/proj',
      taskDescription: 'task',
      role: 'implementer',
    });
    const prompt = wm.configs[0]?.prompt ?? '';
    expect(prompt).toContain('pnpm test');
    expect(prompt).toContain('pnpm build');
    expect(prompt).toContain('pnpm lint');
  });

  it('renders (none) for unsourced commands when resolveProjectCommands is absent', async () => {
    const wm = makeWm();
    const lc = createWorkerLifecycle({
      registry: new WorkerRegistry(),
      workerManager: wm.mgr,
      worktreeManager: stubWt(),
    });
    await lc.spawn({
      id: 'wk-none',
      projectPath: '/p/proj',
      taskDescription: 'task',
      role: 'implementer',
    });
    // The suffix's DoD block lists the commands; with no resolver they
    // collapse to the (none) sentinel rather than leaking "undefined".
    const prompt = wm.configs[0]?.prompt ?? '';
    expect(prompt).toContain('(none)');
    expect(prompt).not.toContain('undefined');
  });
});
