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

/**
 * Phase 4F.1 integration — REAL `WorktreeManager` + REAL
 * `createWorkerLifecycle` + REAL `makeSpawnWorkerTool` handler + REAL
 * droid registry/parser/settings-writer + REAL fragment composer. Only
 * the `claude` subprocess (`WorkerManager`) is stubbed (it captures the
 * spawned `WorkerConfig`). Proves the end-to-end fence install: a
 * custom droid spawn writes `<worktree>/.claude/settings.local.json`
 * with the PreToolUse command + ships the policy env; a built-in role
 * spawn is byte-unchanged (zero-regression guard); project droids
 * shadow built-ins by name.
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

const BODY_MARK = 'LOCKED-DROID-BODY-MARKER-7F1';

function droidFile(name: string, extra = ''): string {
  return `---
name: ${name}
model: opus
tools_allowed: [read, grep, glob, write]
tools_denied: [bash, edit]
write_paths: ["DESIGN.md"]
${extra}---

${BODY_MARK}: you are the ${name} droid. Do the thing.
`;
}

let sandbox: string;
let repoPath: string;

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-4f1-'));
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

function writeDroid(name: string, content: string): void {
  const dir = path.join(repoPath, '.symphony', 'droids');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.md`), content);
}

function makeTool() {
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
  return { tool, wm, registry };
}

const args = (over: Record<string, unknown>) => ({
  project: undefined,
  task_description: 'do the work',
  role: 'implementer',
  model: undefined,
  depends_on: undefined,
  autonomy_tier: undefined,
  task_id: undefined,
  ...over,
});

describe('Phase 4F.1 — custom droid spawn installs the PreToolUse fence', () => {
  it('writes settings.local.json + ships policy env + composes the droid body', async () => {
    writeDroid('locked-droid', droidFile('locked-droid'));
    const { tool, wm, registry } = makeTool();

    const res = await tool.handler(
      args({ role: 'locked-droid' }) as never,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).toContain(
      'droid: locked-droid',
    );

    const id = registry.list()[0]!.id;
    const wt = path.join(repoPath, '.symphony', 'worktrees', id);
    const settingsPath = path.join(wt, '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = parseJsonc(readFileSync(settingsPath, 'utf8')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const cmd = settings.hooks.PreToolUse[0]!.hooks[0]!.command;
    expect(cmd).toContain(DROID_FENCE_MARKER);
    expect(cmd).not.toMatch(/\|\|\s*true/); // exit 2 IS the block

    const cfg = wm.configs[0]!;
    expect(cfg.extraEnv?.[DROID_WORKTREE_ENV]).toBe(wt);
    expect(JSON.parse(cfg.extraEnv![DROID_FENCE_ENV]!)).toEqual({
      allowed: ['Read', 'Grep', 'Glob', 'Write'],
      denied: ['Bash', 'Edit', 'MultiEdit', 'NotebookEdit'],
      writePaths: ['DESIGN.md'],
    });
    expect(cfg.allowExtraEnvKeys).toEqual([
      DROID_FENCE_ENV,
      DROID_WORKTREE_ENV,
    ]);
    expect(cfg.model).toBe('opus'); // droid frontmatter model

    // Manual = droid body + common suffix (Phase 4E contract), in CLAUDE.md.
    const claudeMd = readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(BODY_MARK);
    // The common suffix (Phase 4E contract) is appended after the droid
    // body — same proven marker the 4D.2 injection test asserts.
    expect(claudeMd).toContain('### Reporting Format — MANDATORY');
  });

  it('built-in role spawn is byte-unchanged: no fence settings, no policy env', async () => {
    const { tool, wm, registry } = makeTool();
    const res = await tool.handler(args({ role: 'researcher' }) as never, ctx());
    expect(res.isError).toBeFalsy();

    const id = registry.list()[0]!.id;
    const wt = path.join(repoPath, '.symphony', 'worktrees', id);
    expect(existsSync(path.join(wt, '.claude', 'settings.local.json'))).toBe(
      false,
    );
    const cfg = wm.configs[0]!;
    expect(cfg.extraEnv).toBeUndefined();
    expect(cfg.allowExtraEnvKeys).toBeUndefined();
    const claudeMd = readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Researcher');
    expect(claudeMd).not.toContain(BODY_MARK);
  });

  it('a project droid named like a built-in SHADOWS the built-in', async () => {
    writeDroid('implementer', droidFile('implementer'));
    const { tool, wm, registry } = makeTool();
    const res = await tool.handler(
      args({ role: 'implementer' }) as never,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).toContain(
      'droid: implementer',
    );
    const id = registry.list()[0]!.id;
    const wt = path.join(repoPath, '.symphony', 'worktrees', id);
    expect(existsSync(path.join(wt, '.claude', 'settings.local.json'))).toBe(
      true,
    );
    const claudeMd = readFileSync(path.join(wt, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(BODY_MARK); // droid body, not built-in opener
    expect(wm.configs[0]!.extraEnv?.[DROID_FENCE_ENV]).toBeDefined();
  });

  it('unknown role → structured error listing built-ins + project droids', async () => {
    writeDroid('locked-droid', droidFile('locked-droid'));
    const { tool } = makeTool();
    const res = await tool.handler(args({ role: 'nope' }) as never, ctx());
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("Unknown role 'nope'");
    expect(text).toContain('implementer');
    expect(text).toContain('locked-droid');
  });

  it('a malformed sibling droid does not block a valid spawn; warning surfaced', async () => {
    writeDroid('locked-droid', droidFile('locked-droid'));
    writeDroid('broken', '---\nname: broken\nbogus: 1\n---\nbody');
    const { tool } = makeTool();
    const res = await tool.handler(
      args({ role: 'locked-droid' }) as never,
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('droid: locked-droid');
    expect(text).toMatch(/Note: 1 droid file\(s\) skipped/);
    expect(text).toContain('broken.md');
  });
});
