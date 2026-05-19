/**
 * Phase 4F.1 production scenario — closes the loop: a real custom-droid
 * spawn through the REAL `makeSpawnWorkerTool` handler writes a REAL
 * `settings.local.json`; the EXACT command + env that spawn produced is
 * then executed as a REAL subprocess against a crafted PreToolUse
 * payload, asserting the REAL exit code/stderr enforce the droid's
 * declared policy. Only the `claude` subprocess (`WorkerManager`) is
 * stubbed.
 */
import { exec, execFile } from 'node:child_process';
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
import { parse as parseJsonc } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWorkerLifecycle } from '../../src/orchestrator/worker-lifecycle.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { makeSpawnWorkerTool } from '../../src/orchestrator/tools/spawn-worker.js';
import { WorktreeManager } from '../../src/worktree/manager.js';
import { DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import {
  DROID_FENCE_ENV,
  DROID_FENCE_MARKER,
  DROID_WORKTREE_ENV,
} from '../../src/droids/hook-command.js';
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

const LOCKED_DROID = `---
name: locked-droid
model: opus
tools_allowed: [read, grep, glob, write]
tools_denied: [bash, edit]
write_paths: ["DESIGN.md"]
---

You are the locked droid. Do exactly what the task says, nothing else.
`;

let sandbox: string;
let repoPath: string;

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-scn-4f1-'));
  repoPath = path.join(sandbox, 'repo');
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.email', 't@e.com');
  await git(repoPath, 'config', 'user.name', 'T');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# scn\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-m', 'init');
  mkdirSync(path.join(repoPath, '.symphony', 'droids'), { recursive: true });
  writeFileSync(
    path.join(repoPath, '.symphony', 'droids', 'locked-droid.md'),
    LOCKED_DROID,
  );
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

interface HookRun {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/** Run a shell command exactly as Claude Code would: shell-form, given
 *  env, stdin piped, returning {exitCode, stderr, stdout}. Never
 *  throws on non-zero exit — the exit code IS the assertion. */
function runHook(
  command: string,
  env: Record<string, string>,
  stdin: string,
  cwd: string,
): Promise<HookRun> {
  return new Promise((resolve) => {
    const child = exec(command, { env, cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += String(c)));
    child.stderr?.on('data', (c) => (stderr += String(c)));
    child.on('close', (code) =>
      resolve({ exitCode: code ?? -1, stderr, stdout }),
    );
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

function makePayload(
  toolName: string,
  cwd: string,
  filePath?: string,
): string {
  return JSON.stringify({
    session_id: 's',
    transcript_path: '/x.jsonl',
    cwd,
    permission_mode: 'bypassPermissions',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: filePath !== undefined ? { file_path: filePath } : {},
    tool_use_id: 't1',
  });
}

describe('Phase 4F.1 scenario — installed fence enforces declared policy end-to-end', () => {
  it('Section 1+2 — real spawn writes the fence; real subprocess enforces it', async () => {
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

    const spawnRes = await tool.handler(
      {
        project: undefined,
        task_description: 'do the work',
        role: 'locked-droid',
        model: undefined,
        depends_on: undefined,
        autonomy_tier: undefined,
        task_id: undefined,
      } as never,
      ctx(),
    );
    expect(spawnRes.isError).toBeFalsy();

    const id = registry.list()[0]!.id;
    const wt = path.join(repoPath, '.symphony', 'worktrees', id);
    const settingsPath = path.join(wt, '.claude', 'settings.local.json');

    // ── Section 1: spawn wired the fence ──────────────────────────────
    const settings = parseJsonc(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
    expect(command).toContain(DROID_FENCE_MARKER);
    expect(command).not.toMatch(/\|\|\s*true/);

    const cfg = wm.configs[0]!;
    expect(cfg.extraEnv?.[DROID_WORKTREE_ENV]).toBe(wt);
    expect(cfg.allowExtraEnvKeys).toEqual([
      DROID_FENCE_ENV,
      DROID_WORKTREE_ENV,
    ]);
    const env = {
      ...process.env,
      ...cfg.extraEnv,
    } as Record<string, string>;

    // ── Section 2: real fence-hook subprocess enforces policy ─────────

    // Allowed read tool — exit 0.
    const allowRead = await runHook(
      command,
      env,
      makePayload('Read', wt, path.join(wt, 'README.md')),
      wt,
    );
    expect(allowRead.exitCode).toBe(0);

    // Denied tool (Bash) — exit 2.
    const denyBash = await runHook(command, env, makePayload('Bash', wt), wt);
    expect(denyBash.exitCode).toBe(2);
    expect(denyBash.stderr).toMatch(/denied|not in this droid/);

    // Write to write_paths target — exit 0.
    const allowWrite = await runHook(
      command,
      env,
      makePayload('Write', wt, path.join(wt, 'DESIGN.md')),
      wt,
    );
    expect(allowWrite.exitCode).toBe(0);

    // Write to a path not in write_paths — exit 2.
    const denyWritePath = await runHook(
      command,
      env,
      makePayload('Write', wt, path.join(wt, 'src', 'x.ts')),
      wt,
    );
    expect(denyWritePath.exitCode).toBe(2);
    expect(denyWritePath.stderr).toMatch(/write_paths/);

    // Write outside the worktree — exit 2.
    const denyWriteEscape = await runHook(
      command,
      env,
      makePayload('Write', wt, path.resolve('/etc/passwd')),
      wt,
    );
    expect(denyWriteEscape.exitCode).toBe(2);
    expect(denyWriteEscape.stderr).toMatch(/outside the worktree/);

    // Malformed PreToolUse stdin — fail closed (exit 2).
    const denyBadJson = await runHook(command, env, 'not json at all', wt);
    expect(denyBadJson.exitCode).toBe(2);

    // Without the policy env (not a fenced context) — exit 0 (never
    // brick a worker over a wiring mistake on our side).
    const passthroughEnv = { ...process.env } as Record<string, string>;
    delete passthroughEnv[DROID_FENCE_ENV];
    delete passthroughEnv[DROID_WORKTREE_ENV];
    const passthrough = await runHook(
      command,
      passthroughEnv,
      makePayload('Bash', wt),
      wt,
    );
    expect(passthrough.exitCode).toBe(0);
  }, 30_000);
});
