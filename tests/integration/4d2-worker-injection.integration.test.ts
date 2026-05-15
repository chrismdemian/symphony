import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkerLifecycle } from '../../src/orchestrator/worker-lifecycle.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { WorktreeManager } from '../../src/worktree/manager.js';
import { WORKER_CLAUDE_MD_SENTINEL } from '../../src/orchestrator/worker-claude-md.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type {
  StreamEvent,
  Worker,
  WorkerConfig,
  WorkerExitInfo,
} from '../../src/workers/types.js';

/**
 * Phase 4D.2 integration — REAL `WorktreeManager` + REAL
 * `createWorkerLifecycle` + REAL `PromptComposer` (frozen
 * research/prompts/fragments). Only the `claude` subprocess
 * (`WorkerManager`) is stubbed. Proves the Multica injection path
 * end-to-end: the role manual lands in `<worktree>/CLAUDE.md` (git-
 * excluded), and the stdin kickoff is task-only.
 */

const execFileAsync = promisify(execFile);
const git = (cwd: string, ...args: string[]) =>
  execFileAsync('git', args, { cwd });

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
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-4d2-'));
  repoPath = path.join(sandbox, 'repo');
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.email', 't@e.com');
  await git(repoPath, 'config', 'user.name', 'T');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
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

describe('Phase 4D.2 — worker prompt injected as worktree CLAUDE.md', () => {
  it('writes the role manual to <worktree>/CLAUDE.md; stdin is task-only; CLAUDE.md is git-excluded', async () => {
    const wm = makeWm();
    const lc = createWorkerLifecycle({
      registry: new WorkerRegistry(),
      workerManager: wm.mgr,
      worktreeManager: new WorktreeManager({ runProjectPrep: false }),
    });

    await lc.spawn({
      id: 'wk-4d2',
      projectPath: repoPath,
      taskDescription: 'land the approved auth refactor',
      role: 'implementer',
    });

    const worktreePath = path.join(
      repoPath,
      '.symphony',
      'worktrees',
      'wk-4d2',
    );
    const claudeMdPath = path.join(worktreePath, 'CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);

    const claudeMd = readFileSync(claudeMdPath, 'utf8');
    expect(claudeMd.startsWith(WORKER_CLAUDE_MD_SENTINEL)).toBe(true);
    expect(claudeMd).toContain('## Your Role: Implementer');
    expect(claudeMd).toContain('### Reporting Format — MANDATORY');

    // stdin kickoff = task only (role text is in CLAUDE.md now).
    const prompt = wm.configs[0]?.prompt ?? '';
    expect(prompt).toBe(
      '# Your Task\n\nland the approved auth refactor\n',
    );
    expect(prompt).not.toContain('## Your Role:');

    // .git/info/exclude (DEFAULT_GIT_EXCLUDE_PATTERNS) keeps the injected
    // CLAUDE.md out of git — never committed into the user's repo.
    const { stdout } = await git(
      worktreePath,
      'status',
      '--porcelain',
      '--untracked-files=all',
    );
    expect(stdout).not.toContain('CLAUDE.md');
  });
});
