/**
 * Phase 3O.2 — open_pr integration. Real temp git repo + REAL generatePrContent
 * + REAL git-ops range helpers, driven through the tool handler. The only
 * fakes are the two external processes: the one-shot `claude` runner and the
 * `gh` CLI. Never opens a real PR, never pushes to a real remote.
 *
 * This proves the real generator + parser feed the real `gh pr create` call
 * (the open-pr.unit test stubs the generator; this one does not).
 */

import { execFileSync } from 'node:child_process';
import { promises as fsp, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeOpenPrTool } from '../../src/orchestrator/tools/open-pr.js';
import type { GhCreatePrInput, GhCreatePrResult, GhRunner } from '../../src/orchestrator/gh-cli.js';
import type { OneShotResult, OneShotRunner } from '../../src/orchestrator/one-shot.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';

const ctx: DispatchContext = { mode: 'act', tier: 2, awayMode: false, automationContext: false };
const ROOT = '/virtual/project-root';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function initRepoWithFeature(dir: string): string {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  const base = git(dir, ['branch', '--show-current']);
  git(dir, ['checkout', '-q', '-b', 'feature/login']);
  writeFileSync(path.join(dir, 'login.ts'), 'export const login = () => {};\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'feat: add login helper']);
  return base;
}

function stubWorker(): Worker {
  return {
    id: 'wk',
    status: 'completed',
    events: (async function* () {})(),
    sendFollowup: () => {},
    endInput: () => {},
    kill: () => {},
    waitForExit: async () => ({ status: 'completed', exitCode: 0, signal: null, durationMs: 0 }),
  } as unknown as Worker;
}

function registerWorker(reg: WorkerRegistry, worktreePath: string): void {
  const record: WorkerRecord = {
    id: 'wk',
    projectPath: ROOT,
    projectId: 'p1',
    taskId: null,
    worktreePath,
    role: 'implementer',
    featureIntent: 'add-login',
    taskDescription: 'add login',
    autonomyTier: 2,
    dependsOn: [],
    status: 'completed',
    createdAt: new Date().toISOString(),
    worker: stubWorker(),
    buffer: new CircularBuffer<StreamEvent>(10),
    auditAttempts: 0,
    detach: () => {},
  };
  reg.register(record);
}

function oneShot(text: string): OneShotRunner {
  return async (): Promise<OneShotResult> => ({
    rawStdout: text,
    text,
    exitCode: 0,
    signaled: false,
    durationMs: 1,
    stderrTail: '',
  });
}

function fakeGh(result?: GhCreatePrResult): { gh: GhRunner; inputs: GhCreatePrInput[] } {
  const inputs: GhCreatePrInput[] = [];
  return {
    inputs,
    gh: {
      checkAvailable: async () => ({ available: true }),
      hasGitHubRemote: async () => true,
      createPr: async (input) => {
        inputs.push(input);
        return result ?? { url: 'https://github.com/o/r/pull/77', alreadyExisted: false };
      },
    },
  };
}

const noopPush: NonNullable<Parameters<typeof makeOpenPrTool>[0]['push']> = async (opts) => ({
  remote: opts.remote ?? 'origin',
  branch: opts.branch ?? 'feature/login',
  setUpstream: true,
});

let dir: string;
let base: string;
let registry: WorkerRegistry;
let projectStore: ProjectRegistry;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sym-3o2-int-'));
  base = initRepoWithFeature(dir);
  registry = new WorkerRegistry();
  registerWorker(registry, dir);
  projectStore = new ProjectRegistry();
  projectStore.register({ id: 'p1', name: 'demo', path: ROOT, createdAt: '2026-06-01T00:00:00.000Z' });
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('Phase 3O.2 — open_pr end-to-end (real generator + git, fake gh/claude)', () => {
  it('runs the real generator over the real diff and opens the PR with LLM content', async () => {
    const { gh, inputs } = fakeGh();
    const out = await makeOpenPrTool({
      registry,
      projectStore,
      ghRunner: gh,
      push: noopPush,
      oneShotRunner: oneShot('{"title":"feat: login helper","description":"## What\\nAdds a login helper."}'),
    }).handler(
      { worker_id: 'wk', base: undefined, draft: undefined, title: undefined, body: undefined, model: undefined },
      ctx,
    );

    expect(out.isError).toBeUndefined();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.base).toBe(base);
    expect(inputs[0]?.head).toBe('feature/login');
    expect(inputs[0]?.title).toBe('feat: login helper');
    expect(inputs[0]?.body).toContain('Adds a login helper.');
    expect(out.structuredContent?.description_source).toBe('llm');
    expect(out.structuredContent?.url).toBe('https://github.com/o/r/pull/77');
  });

  it('falls back to the heuristic (real commit subject) when claude output is garbage', async () => {
    const { gh, inputs } = fakeGh();
    const out = await makeOpenPrTool({
      registry,
      projectStore,
      ghRunner: gh,
      push: noopPush,
      oneShotRunner: oneShot('this is not json'),
    }).handler(
      { worker_id: 'wk', base: undefined, draft: undefined, title: undefined, body: undefined, model: undefined },
      ctx,
    );

    expect(out.isError).toBeUndefined();
    expect(out.structuredContent?.description_source).toBe('heuristic');
    // Heuristic title derives from the real commit subject.
    expect(inputs[0]?.title).toBe('feat: add login helper');
    expect(inputs[0]?.body).toContain('## Changes');
    expect(inputs[0]?.body).toContain('- feat: add login helper');
  });
});
