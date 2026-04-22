import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkerManager } from '../../src/workers/manager.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';
import { WorktreeManager } from '../../src/worktree/manager.js';

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
    '[1c scenario] `claude --version` unavailable — real-claude scenario will skip. Install the CLI and re-run locally to exercise Gate 3.',
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
  writeFileSync(path.join(repoPath, 'README.md'), '# Phase 1C scenario\n');
  writeFileSync(path.join(repoPath, '.gitignore'), '.env\nnode_modules/\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-m', 'init');
}

describe('Phase 1C production scenario — real worktree + real claude reads preserved .env', () => {
  let sandbox: string;
  let projectPath: string;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-1c-'));
    projectPath = path.join(sandbox, 'repo');
    await execFileAsync('mkdir', ['-p', projectPath]).catch(() => {
      // Windows: mkdirSync via fs is required
    });
    if (!existsSync(projectPath)) {
      const fs = await import('node:fs');
      fs.mkdirSync(projectPath, { recursive: true });
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
    'creates worktree, preserves .env, real worker reads it and emits a structured completion',
    async () => {
      const secret = `symphony-1c-${Date.now()}`;
      writeFileSync(path.join(projectPath, '.env'), `SECRET=${secret}\n`);

      const wtManager = new WorktreeManager({ runProjectPrep: false });
      const info = await wtManager.create({
        projectPath,
        workerId: 'scenario-1c',
        shortDescription: 'read env',
      });

      expect(info.path).toBe(path.join(projectPath, '.symphony', 'worktrees', 'scenario-1c'));
      expect(info.branch).toBe('symphony/scenario-1c/read-env');
      expect(existsSync(info.path)).toBe(true);

      const preservedEnv = readFileSync(path.join(info.path, '.env'), 'utf8');
      expect(preservedEnv).toBe(`SECRET=${secret}\n`);

      const gitDirOut = await git(info.path, 'rev-parse', '--git-dir');
      const gitDir = gitDirOut.trim();
      const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(info.path, gitDir);
      const excludeContent = readFileSync(path.join(absGitDir, 'info', 'exclude'), 'utf8');
      for (const pattern of ['.agent_context', 'CLAUDE.md', 'AGENTS.md', '.symphony/', '.claude/']) {
        expect(excludeContent).toContain(pattern);
      }

      const mgr = new WorkerManager();
      try {
        const worker = await mgr.spawn({
          id: 'scenario-1c-worker',
          cwd: info.path,
          deterministicUuidInput: `scenario-1c::${info.path}`,
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

      const removed = await wtManager.removeIfClean(info.path);
      expect(removed).toBe(true);
      expect(existsSync(info.path)).toBe(false);
      const branches = await git(projectPath, 'branch', '--list', info.branch);
      expect(branches.trim()).toBe('');
    },
    240_000,
  );
});
