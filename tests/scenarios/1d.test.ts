import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkerManager } from '../../src/workers/manager.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';
import { ProjectLockRegistry } from '../../src/worktree/locks.js';
import { WorktreeManager } from '../../src/worktree/manager.js';
import { WorktreePool } from '../../src/worktree/pool.js';

const execFileAsync = promisify(execFile);

const claudeAvailable = detectClaude();

function detectClaude(): boolean {
  try {
    const result = spawnSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      shell: false,
    });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

if (!claudeAvailable) {
  console.warn(
    '[1d scenario] `claude --version` unavailable — real-claude scenario will skip. Install the CLI and re-run locally to exercise Gate 3.',
  );
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function drain(worker: Worker): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of worker.events) events.push(ev);
  return events;
}

async function initRepo(repoPath: string): Promise<void> {
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'Symphony Scenario');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# Phase 1D scenario\n');
  writeFileSync(path.join(repoPath, '.gitignore'), '.env\nnode_modules/\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-m', 'init');
}

describe('Phase 1D production scenario — pool claim + real claude reads preserved .env', () => {
  let sandbox: string;
  let projectPath: string;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-1d-'));
    projectPath = path.join(sandbox, 'repo');
    if (!existsSync(projectPath)) {
      mkdirSync(projectPath, { recursive: true });
    }
    await initRepo(projectPath);
  });

  afterEach(() => {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it.skipIf(!claudeAvailable)(
    'pool-enabled WorktreeManager.create claims a reserve; real worker reads preserved .env; pool replenishes',
    async () => {
      const secret = `symphony-1d-${Date.now()}`;
      writeFileSync(path.join(projectPath, '.env'), `SECRET=${secret}\n`);
      writeFileSync(
        path.join(projectPath, '.symphony.json'),
        JSON.stringify({ worktreePool: { enabled: true } }),
      );

      const locks = new ProjectLockRegistry();
      const pool = new WorktreePool({ runPoll: false, locks });

      const claimEvents: Array<{ worktreePath: string; workerId: string }> = [];
      const fallbackEvents: Array<{ workerId: string; reason: string }> = [];

      const wtManager = new WorktreeManager({
        runProjectPrep: false,
        locks,
        pool,
        events: {
          onPoolClaim: (info) =>
            claimEvents.push({ worktreePath: info.worktreePath, workerId: info.workerId }),
          onPoolFallback: ({ workerId, reason }) =>
            fallbackEvents.push({ workerId, reason }),
        },
      });

      await pool.ensureReserve(projectPath);
      expect(pool.listReserves()).toHaveLength(1);
      const warmedReservePath = pool.listReserves()[0]!.path;

      const info = await wtManager.create({
        projectPath,
        workerId: 'scenario-1d',
        shortDescription: 'pool claim',
      });

      expect(claimEvents).toHaveLength(1);
      expect(claimEvents[0]?.workerId).toBe('scenario-1d');
      expect(fallbackEvents).toEqual([]);

      expect(info.path).toBe(path.join(projectPath, '.symphony', 'worktrees', 'scenario-1d'));
      expect(info.branch).toBe('symphony/scenario-1d/pool-claim');
      expect(existsSync(info.path)).toBe(true);
      expect(existsSync(warmedReservePath)).toBe(false);

      const preservedEnv = readFileSync(path.join(info.path, '.env'), 'utf8');
      expect(preservedEnv).toBe(`SECRET=${secret}\n`);

      const gitDirOut = await git(info.path, 'rev-parse', '--git-common-dir');
      const gitDir = gitDirOut.trim();
      const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(info.path, gitDir);
      const excludeContent = readFileSync(path.join(absGitDir, 'info', 'exclude'), 'utf8');
      for (const pattern of ['.agent_context', 'CLAUDE.md', 'AGENTS.md', '.symphony/', '.claude/']) {
        expect(excludeContent).toContain(pattern);
      }

      const mgr = new WorkerManager();
      try {
        const worker = await mgr.spawn({
          id: 'scenario-1d-worker',
          cwd: info.path,
          deterministicUuidInput: `scenario-1d::${info.path}`,
          prompt: [
            'Use the Read tool to read the file `.env` in the current working directory.',
            'It contains a single line of the form `SECRET=<value>`.',
            'Then emit ONE structured completion JSON fence (```json ... ```) with this exact shape and nothing else after it:',
            '{',
            '  "did": ["<value>"],',
            '  "skipped": [],',
            '  "blockers": [],',
            '  "open_questions": [],',
            '  "audit": "PASS",',
            '  "cite": [".env"],',
            '  "tests_run": [],',
            '  "preview_url": null',
            '}',
            'Where <value> is the literal string after `SECRET=` on the line. No quoting tricks; reproduce it byte-for-byte.',
          ].join('\n'),
          timeoutMs: 90_000,
        });
        const events = await drain(worker);
        const exit = await worker.waitForExit();

        expect(exit.status).toBe('completed');
        expect(exit.exitCode).toBe(0);
        expect(events.some((e) => e.type === 'parse_error')).toBe(false);

        const completion = events.find((e) => e.type === 'structured_completion');
        if (completion?.type !== 'structured_completion') {
          throw new Error('expected a structured_completion event');
        }
        expect(completion.report.did[0]).toContain(secret);
      } finally {
        await mgr.shutdown();
      }

      // Background replenishment should have warmed a fresh reserve. Await
      // it via ensureReserve (which serializes behind any in-flight creation).
      await pool.ensureReserve(projectPath);
      const afterClaim = pool.listReserves();
      expect(afterClaim).toHaveLength(1);
      expect(afterClaim[0]!.path).not.toBe(info.path);
      expect(afterClaim[0]!.path).not.toBe(warmedReservePath);

      const removed = await wtManager.removeIfClean(info.path);
      expect(removed).toBe(true);
      expect(existsSync(info.path)).toBe(false);
      const branches = await git(projectPath, 'branch', '--list', info.branch);
      expect(branches.trim()).toBe('');

      await pool.cleanup();
    },
    240_000,
  );
});
