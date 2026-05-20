import { execFile } from 'node:child_process';
import {
  existsSync,
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
 * Phase 4F.2 integration — bundled `design-researcher` droid resolves
 * through the REAL `makeSpawnWorkerTool` handler with REAL
 * `loadBundledDroids`, REAL `createWorkerLifecycle`, REAL
 * `WorktreeManager` on a REAL git sandbox. Only `WorkerManager` is
 * stubbed (captures WorkerConfig). Asserts:
 *   - bundled droid is spawnable by name
 *   - {design_catalog_dir} is substituted in the worker's manual
 *   - fence settings are written + policy env present
 *   - WorkerRecord.droidName surfaces on snapshot (audit M5 deferral)
 *   - a project droid with the SAME name SHADOWS the bundled one
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
const FAKE_CATALOG = '/abs/symphony/design-catalog';

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-4f2-int-'));
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
    systemVars: { design_catalog_dir: FAKE_CATALOG },
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
  return { tool, wm, registry, bundled };
}

const args = (over: Record<string, unknown>) => ({
  project: undefined,
  task_description: '[design-researcher: SURVEY] minimal dev tool landing page',
  role: 'design-researcher',
  model: undefined,
  depends_on: undefined,
  autonomy_tier: undefined,
  task_id: undefined,
  ...over,
});

describe('Phase 4F.2 — bundled design-researcher droid integration', () => {
  it('spawns from bundled registry with substituted catalog dir + fence + droidName', async () => {
    const { tool, wm, registry } = await setup();
    const res = await tool.handler(args({}) as never, ctx());
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).toContain(
      'droid:design-researcher',
    );

    const record = registry.list()[0]!;
    // M5: droidName surfaces on the in-memory record + snapshot.
    expect(record.droidName).toBe('design-researcher');

    const wt = record.worktreePath;
    const claudeMd = readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8');
    // System var substituted at boot.
    expect(claudeMd).toContain(FAKE_CATALOG);
    expect(claudeMd).not.toContain('{design_catalog_dir}');
    // Common suffix (Phase 4E completion contract) appended.
    expect(claudeMd).toContain('### Reporting Format — MANDATORY');

    // Fence wired: PreToolUse settings + policy env.
    expect(
      existsSync(path.join(wt, '.claude', 'settings.local.json')),
    ).toBe(true);
    const cfg = wm.configs[0]!;
    expect(cfg.extraEnv?.SYMPHONY_DROID_FENCE).toBeDefined();
    const policy = JSON.parse(cfg.extraEnv!.SYMPHONY_DROID_FENCE!);
    expect(policy.writePaths).toEqual(['DESIGN.md']);
    expect(policy.denied).toContain('Bash');
    expect(policy.allowed).toContain('Write');
    // Model = opus per the droid frontmatter.
    expect(cfg.model).toBe('opus');
  });

  // 4F.2 audit C1 — malformed `design-researcher.md` (a BUNDLED droid
  // name) must fail closed, NOT silently fall through to the less-
  // restrictive bundled droid. Same security class as 4F.1 C2 but for
  // the bundled tier; hoisted shadow-check covers both.
  it('malformed <bundled>.md shadow rejects (fail closed, audit C1)', async () => {
    const droidsDir = path.join(repoPath, '.symphony', 'droids');
    mkdirSync(droidsDir, { recursive: true });
    writeFileSync(
      path.join(droidsDir, 'design-researcher.md'),
      '---\nname: design-researcher\nbogus_key: 1\n---\nbody',
    );
    const { tool } = await setup();
    const res = await tool.handler(args({}) as never, ctx());
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("Cannot spawn 'design-researcher'");
    expect(text).toContain('intended to shadow the bundled');
    expect(text).toContain('design-researcher.md');
  });

  it('project droid SHADOWS a bundled droid of the same name', async () => {
    // Write a project droid with the same name as the bundled one.
    const droidsDir = path.join(repoPath, '.symphony', 'droids');
    mkdirSync(droidsDir, { recursive: true });
    writeFileSync(
      path.join(droidsDir, 'design-researcher.md'),
      `---\nname: design-researcher\ntools_denied: [bash]\n---\nPROJECT-OVERRIDE-MARKER`,
    );

    const { tool, wm, registry } = await setup();
    const res = await tool.handler(args({}) as never, ctx());
    expect(res.isError).toBeFalsy();

    const record = registry.list()[0]!;
    const claudeMd = readFileSync(
      path.join(record.worktreePath, 'CLAUDE.md'),
      'utf8',
    );
    expect(claudeMd).toContain('PROJECT-OVERRIDE-MARKER');
    // The bundled body's distinctive text is absent.
    expect(claudeMd).not.toContain(FAKE_CATALOG);
    // Custom droid path still applies the fence (project droid has tools_denied).
    expect(wm.configs[0]!.extraEnv?.SYMPHONY_DROID_FENCE).toBeDefined();
  });
});
