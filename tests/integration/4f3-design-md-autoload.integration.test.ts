import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkerLifecycle } from '../../src/orchestrator/worker-lifecycle.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { makeSpawnWorkerTool } from '../../src/orchestrator/tools/spawn-worker.js';
import { WorktreeManager } from '../../src/worktree/manager.js';
import { DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import { loadBundledDroids } from '../../src/droids/bundled.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type {
  StreamEvent,
  Worker,
  WorkerConfig,
  WorkerExitInfo,
} from '../../src/workers/types.js';

/**
 * Phase 4F.3 integration — DESIGN.md auto-load for built-in
 * implementer workers (rule #13 post-write nudge). REAL spawn pipeline
 * (lifecycle + worktree + handler + composer) on a REAL git sandbox;
 * only WorkerManager stubbed (captures the composed prompt that
 * reaches `claude -p`).
 */

const execFileAsync = promisify(execFile);
const git = (cwd: string, ...a: string[]) => execFileAsync('git', a, { cwd });
function ctx(): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act' };
}

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

let sandbox: string;
let repoPath: string;

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-4f3-int-'));
  repoPath = path.join(sandbox, 'repo');
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.email', 't@e.com');
  await git(repoPath, 'config', 'user.name', 'T');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# scn\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-m', 'init');
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function setup() {
  const bundled = await loadBundledDroids({
    systemVars: { design_catalog_dir: '/abs/sym/design-catalog' },
  });
  const wm = makeWm();
  const registry = new WorkerRegistry();
  const lifecycle = createWorkerLifecycle({
    registry,
    workerManager: wm.mgr,
    worktreeManager: new WorktreeManager({ runProjectPrep: false }),
  });
  const tool = makeSpawnWorkerTool({
    registry,
    lifecycle,
    resolveProjectPath: () => repoPath,
    bundledDroids: bundled.droids,
  });
  return { tool, wm, registry };
}

const args = (over: Record<string, unknown>) => ({
  project: undefined,
  task_description: 'land the auth refactor',
  role: 'implementer',
  model: undefined,
  depends_on: undefined,
  autonomy_tier: undefined,
  task_id: undefined,
  ...over,
});

const AUTO_LOAD_NEEDLE =
  'this project has a `DESIGN.md` at the repo root — read it before writing any UI';

function workerKickoffText(repo: string, registry: WorkerRegistry): string {
  // The kickoff lands in `<worktree>/CLAUDE.md` when injection
  // succeeded (default path on the test sandbox) plus the stdin
  // `cfg.prompt`. We read whichever contains the additional note —
  // 4D.2 puts the role manual in CLAUDE.md and the task kickoff on
  // stdin; the auto-load note rides the KICKOFF (per the
  // composeWorkerTaskKickoff additionalNote slot).
  const record = registry.list()[0]!;
  // Stdin prompt is on cfg.prompt; CLAUDE.md contains the manual.
  return path.join(record.worktreePath, 'CLAUDE.md');
}

describe('Phase 4F.3 — DESIGN.md auto-load for implementer workers', () => {
  it('built-in implementer ON project WITH DESIGN.md gets the auto-load note', async () => {
    writeFileSync(path.join(repoPath, 'DESIGN.md'), '# spec\n');
    const { tool, wm } = await setup();
    const res = await tool.handler(args({}) as never, ctx());
    expect(res.isError).toBeFalsy();
    // The kickoff (stdin) carries the additional note.
    const stdinPrompt = wm.configs[0]!.prompt;
    expect(stdinPrompt).toContain(AUTO_LOAD_NEEDLE);
    // And the manual (CLAUDE.md) is unchanged — auto-load is
    // additive on kickoff, not part of the byte-fidelity manual.
    void workerKickoffText; // helper retained but not used here
  });

  it('built-in implementer on project WITHOUT DESIGN.md gets NO note (regression guard)', async () => {
    const { tool, wm } = await setup();
    const res = await tool.handler(args({}) as never, ctx());
    expect(res.isError).toBeFalsy();
    const stdinPrompt = wm.configs[0]!.prompt;
    expect(stdinPrompt).not.toContain(AUTO_LOAD_NEEDLE);
  });

  it('built-in researcher on project WITH DESIGN.md does NOT auto-load (only implementer)', async () => {
    writeFileSync(path.join(repoPath, 'DESIGN.md'), '# spec\n');
    const { tool, wm } = await setup();
    const res = await tool.handler(args({ role: 'researcher' }) as never, ctx());
    expect(res.isError).toBeFalsy();
    const stdinPrompt = wm.configs[0]!.prompt;
    expect(stdinPrompt).not.toContain(AUTO_LOAD_NEEDLE);
  });

  it('bundled design-researcher droid does NOT auto-load (it IS the writer)', async () => {
    writeFileSync(path.join(repoPath, 'DESIGN.md'), '# spec\n');
    const { tool, wm } = await setup();
    const res = await tool.handler(
      args({
        role: 'design-researcher',
        task_description: '[design-researcher: WRITE raycast] minimal dev tool',
      }) as never,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const stdinPrompt = wm.configs[0]!.prompt;
    expect(stdinPrompt).not.toContain(AUTO_LOAD_NEEDLE);
  });

  it('custom (project) droid does NOT auto-load (own task contract)', async () => {
    writeFileSync(path.join(repoPath, 'DESIGN.md'), '# spec\n');
    const droidsDir = path.join(repoPath, '.symphony', 'droids');
    mkdirSync(droidsDir, { recursive: true });
    writeFileSync(
      path.join(droidsDir, 'my-reviewer.md'),
      '---\nname: my-reviewer\ntools_denied: [bash]\n---\nReview things.',
    );
    const { tool, wm } = await setup();
    const res = await tool.handler(args({ role: 'my-reviewer' }) as never, ctx());
    expect(res.isError).toBeFalsy();
    const stdinPrompt = wm.configs[0]!.prompt;
    expect(stdinPrompt).not.toContain(AUTO_LOAD_NEEDLE);
  });

  it('note rides the kickoff body AFTER the task (not the role manual)', async () => {
    writeFileSync(path.join(repoPath, 'DESIGN.md'), '# spec\n');
    const { tool, wm } = await setup();
    const TASK = 'unique-task-marker-9X1';
    const res = await tool.handler(
      args({ task_description: TASK }) as never,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const stdinPrompt = wm.configs[0]!.prompt;
    // Order: # Your Task → task body → blank → auto-load note.
    const taskIdx = stdinPrompt.indexOf(TASK);
    const noteIdx = stdinPrompt.indexOf(AUTO_LOAD_NEEDLE);
    expect(taskIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeGreaterThan(taskIdx);
  });
});

describe('Phase 4F.3 — Maestro prompt rule-#13 protocol present', () => {
  it('the delegation-contract fragment includes the design-researcher protocol', () => {
    const fragment = readFileSync(
      path.join(
        process.cwd(),
        'research',
        'prompts',
        'fragments',
        'maestro-delegation-contract.md',
      ),
      'utf8',
    );
    expect(fragment).toContain('Rule #13 — DESIGN.md Protocol');
    expect(fragment).toContain('[design-researcher: SURVEY]');
    expect(fragment).toContain('[design-researcher: WRITE <slug>]');
    expect(fragment).toContain('hasUiStack');
    expect(fragment).toContain('hasDesignMd');
    expect(fragment).toContain('{design_catalog_dir}');
  });
});
