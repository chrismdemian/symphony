/**
 * Phase 4D production scenario — fragment composition (4D.1) + worktree
 * CLAUDE.md injection (4D.2) + skills store (4D.3) + bundled installer
 * (4D.4) + format-preserving JSONC (4D.5), exercised end-to-end through
 * REAL paths: the REAL `spawn_worker` MCP tool → REAL
 * `createWorkerLifecycle` → REAL `WorktreeManager` → REAL git; REAL fs
 * for skills + JSONC. Only the `claude` subprocess is stubbed (to
 * capture `cfg`). Ground truth is bytes on disk / in `cfg.prompt`.
 */
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkerLifecycle } from '../../src/orchestrator/worker-lifecycle.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { makeSpawnWorkerTool } from '../../src/orchestrator/tools/spawn-worker.js';
import { DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import { WorktreeManager } from '../../src/worktree/manager.js';
import { WORKER_CLAUDE_MD_SENTINEL } from '../../src/orchestrator/worker-claude-md.js';
import {
  installBundledSkills,
} from '../../src/skills/bundled.js';
import {
  installSkill,
  listSkills,
  uninstallSkill,
} from '../../src/skills/store.js';
import {
  SYMPHONY_CLAUDE_COMMANDS_DIR_ENV,
  SYMPHONY_SKILLS_DIR_ENV,
} from '../../src/skills/paths.js';
import {
  editJsoncFile,
  parseJsoncObject,
  stripOwnEntriesByMarker,
} from '../../src/utils/jsonc-edit.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type {
  StreamEvent,
  Worker,
  WorkerConfig,
  WorkerExitInfo,
} from '../../src/workers/types.js';

const execFileAsync = promisify(execFile);
const git = (cwd: string, ...a: string[]) => execFileAsync('git', a, { cwd });
const ctx = (): DispatchContext => ({ ...DEFAULT_DISPATCH_CONTEXT, mode: 'act' });

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
let savedSkillsEnv: string | undefined;
let savedAgentEnv: string | undefined;

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-4d-scn-'));
  repoPath = path.join(sandbox, 'repo');
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.email', 't@e.com');
  await git(repoPath, 'config', 'user.name', 'T');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-m', 'init');

  savedSkillsEnv = process.env[SYMPHONY_SKILLS_DIR_ENV];
  savedAgentEnv = process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV];
  process.env[SYMPHONY_SKILLS_DIR_ENV] = path.join(sandbox, 'skills');
  process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV] = path.join(sandbox, 'agent');
});

afterEach(() => {
  if (savedSkillsEnv === undefined) delete process.env[SYMPHONY_SKILLS_DIR_ENV];
  else process.env[SYMPHONY_SKILLS_DIR_ENV] = savedSkillsEnv;
  if (savedAgentEnv === undefined) delete process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV];
  else process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV] = savedAgentEnv;
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('Phase 4D scenario — §1 fragment compose + worktree injection', () => {
  it('spawn_worker injects the fragment manual into <worktree>/CLAUDE.md; stdin is task-only; git-excluded', async () => {
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
    });

    const res = await tool.handler(
      {
        project: repoPath,
        task_description: 'land the approved auth refactor',
        role: 'implementer',
        model: undefined,
        depends_on: undefined,
        autonomy_tier: undefined,
        task_id: undefined,
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();

    const worktreePath = path.join(
      repoPath,
      '.symphony',
      'worktrees',
      registry.list()[0]!.id,
    );
    const claudeMd = await fsp.readFile(
      path.join(worktreePath, 'CLAUDE.md'),
      'utf8',
    );
    expect(claudeMd.startsWith(WORKER_CLAUDE_MD_SENTINEL)).toBe(true);
    expect(claudeMd).toContain('## Your Role: Implementer');
    expect(claudeMd).toContain('### Reporting Format — MANDATORY');

    const prompt = wm.configs[0]?.prompt ?? '';
    expect(prompt).toBe('# Your Task\n\nland the approved auth refactor\n');
    expect(prompt).not.toContain('## Your Role:');
    expect(prompt).not.toContain(WORKER_CLAUDE_MD_SENTINEL);

    const { stdout } = await git(
      worktreePath,
      'status',
      '--porcelain',
      '--untracked-files=all',
    );
    expect(stdout).not.toContain('CLAUDE.md');
  });
});

describe('Phase 4D scenario — §2 skills store + bundled installer', () => {
  it('bundled install is idempotent; custom install/list/uninstall roundtrips', async () => {
    const first = await installBundledSkills();
    expect([...first.installed].sort()).toEqual([
      'dev-browser',
      'json-render',
    ]);
    const second = await installBundledSkills();
    expect(second.installed).toEqual([]);
    expect([...second.skipped].sort()).toEqual([
      'dev-browser',
      'json-render',
    ]);

    await installSkill({ id: 'dhh-reviewer', content: '# DHH Reviewer\n' });
    const listed = await listSkills();
    expect(listed.find((s) => s.id === 'dhh-reviewer')?.linked).toBe(true);

    const un = await uninstallSkill({ id: 'dhh-reviewer' });
    expect(un).toEqual({ removedCentral: true, unlinkedAgent: true });
    expect(
      (await listSkills()).map((s) => s.id).sort(),
    ).toEqual(['dev-browser', 'json-render']);
  });
});

describe('Phase 4D scenario — §3 format-preserving JSONC', () => {
  it('editJsoncFile preserves comments + siblings; stripOwnEntriesByMarker filters', async () => {
    const f = path.join(sandbox, 'settings.local.json');
    await fsp.writeFile(
      f,
      '{\n  // user hook — keep this\n  "hooks": { "Stop": [] },\n  "model": "opus"\n}\n',
    );
    await editJsoncFile(f, [
      { path: ['hooks', 'Stop'], value: [{ marker: 'SYMPHONY_HOOK_PORT' }] },
    ]);
    const text = await fsp.readFile(f, 'utf8');
    expect(text).toContain('// user hook — keep this');
    const parsed = parseJsoncObject(text);
    expect(parsed).toMatchObject({
      hooks: { Stop: [{ marker: 'SYMPHONY_HOOK_PORT' }] },
      model: 'opus',
    });

    const merged = stripOwnEntriesByMarker(
      [
        { cmd: 'curl ... $SYMPHONY_HOOK_PORT ... || true' },
        { cmd: 'user-hook.sh' },
      ],
      'SYMPHONY_HOOK_PORT',
    );
    expect(merged).toEqual([{ cmd: 'user-hook.sh' }]);
  });
});
