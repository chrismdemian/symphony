/**
 * Phase 3O.2 — open_pr tool handler. Real temp git repo (so currentBranch /
 * resolveDefaultMergeTo / resolvePrBaseRef work) + FAKE gh runner, FAKE push,
 * FAKE generator. Never opens a real PR, never pushes to a real remote.
 */

import { execFileSync } from 'node:child_process';
import { promises as fsp, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeOpenPrTool, type OpenPrDeps } from '../../../src/orchestrator/tools/open-pr.js';
import { PushRejectedError } from '../../../src/orchestrator/git-ops.js';
import type {
  GhAvailability,
  GhCreatePrInput,
  GhCreatePrResult,
  GhRunner,
} from '../../../src/orchestrator/gh-cli.js';
import type { generatePrContent } from '../../../src/orchestrator/pr-generation.js';
import { ProjectRegistry } from '../../../src/projects/registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../../src/orchestrator/worker-registry.js';
import type { StreamEvent, Worker } from '../../../src/workers/types.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';

const ctx: DispatchContext = { mode: 'act', tier: 2, awayMode: false, automationContext: false };

/**
 * The tool handler's args type requires every key present (`z.infer` collapses
 * optionals to `T | undefined`, not optional — 2A.4a gotcha). Fill omitted
 * fields with `undefined` explicitly.
 */
function callArgs(p: {
  worker_id: string;
  base?: string;
  draft?: boolean;
  title?: string;
  body?: string;
  model?: string;
}): { worker_id: string; base: string | undefined; draft: boolean | undefined; title: string | undefined; body: string | undefined; model: string | undefined } {
  return {
    worker_id: p.worker_id,
    base: p.base,
    draft: p.draft,
    title: p.title,
    body: p.body,
    model: p.model,
  };
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function initRepoWithFeature(dir: string): { baseBranch: string } {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  const baseBranch = git(dir, ['branch', '--show-current']);
  git(dir, ['checkout', '-q', '-b', 'feature/x']);
  writeFileSync(path.join(dir, 'a.txt'), 'hello\nworld\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'feat: add world']);
  return { baseBranch };
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

function registerWorker(
  reg: WorkerRegistry,
  id: string,
  projectPath: string,
  worktreePath: string,
): WorkerRecord {
  const record: WorkerRecord = {
    id,
    projectPath,
    projectId: 'p1',
    taskId: null,
    worktreePath,
    role: 'implementer',
    featureIntent: 'add-world',
    taskDescription: 'add world',
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
  return record;
}

interface FakeGhConfig {
  available?: GhAvailability;
  hasRemote?: boolean;
  createResult?: GhCreatePrResult;
}

function makeFakeGh(cfg: FakeGhConfig): { gh: GhRunner; createInputs: GhCreatePrInput[] } {
  const createInputs: GhCreatePrInput[] = [];
  const gh: GhRunner = {
    checkAvailable: async () => cfg.available ?? { available: true },
    hasGitHubRemote: async () => cfg.hasRemote ?? true,
    createPr: async (input) => {
      createInputs.push(input);
      return cfg.createResult ?? { url: 'https://github.com/o/r/pull/1', alreadyExisted: false };
    },
  };
  return { gh, createInputs };
}

function makeFakePush(): {
  push: NonNullable<OpenPrDeps['push']>;
  calls: Array<{ branch?: string }>;
  throwWith?: Error;
  setThrow: (e: Error) => void;
} {
  const calls: Array<{ branch?: string }> = [];
  const state: { err?: Error } = {};
  const push: NonNullable<OpenPrDeps['push']> = async (opts) => {
    calls.push({ ...(opts.branch !== undefined ? { branch: opts.branch } : {}) });
    if (state.err) throw state.err;
    return { remote: opts.remote ?? 'origin', branch: opts.branch ?? 'feature/x', setUpstream: true };
  };
  return { push, calls, setThrow: (e) => (state.err = e) };
}

function makeFakeGenerate(): {
  generate: typeof generatePrContent;
  calls: Array<{ baseRef: string | null }>;
} {
  const calls: Array<{ baseRef: string | null }> = [];
  const generate = (async (input) => {
    calls.push({ baseRef: input.baseRef });
    return { title: 'gen: title', description: '## Gen\nbody', source: 'llm' as const };
  }) as typeof generatePrContent;
  return { generate, calls };
}

let dir: string;
let baseBranch: string;
let registry: WorkerRegistry;
let projectStore: ProjectRegistry;
const ROOT = '/virtual/project-root';

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sym-3o2-tool-'));
  baseBranch = initRepoWithFeature(dir).baseBranch;
  registry = new WorkerRegistry();
  projectStore = new ProjectRegistry();
  projectStore.register({ id: 'p1', name: 'demo', path: ROOT, createdAt: '2026-06-01T00:00:00.000Z' });
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
});

function deps(over: Partial<OpenPrDeps> = {}): OpenPrDeps {
  const { gh } = makeFakeGh({});
  const { push } = makeFakePush();
  const { generate } = makeFakeGenerate();
  return { registry, projectStore, ghRunner: gh, push, generate, ...over };
}

describe('Phase 3O.2 — open_pr handler', () => {
  it('errors on an unknown worker', async () => {
    const out = await makeOpenPrTool(deps()).handler(callArgs({ worker_id: 'nope' }), ctx);
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain('Unknown worker');
  });

  it('errors when gh is unavailable, surfacing the reason code', async () => {
    const { gh } = makeFakeGh({
      available: { available: false, reason: 'gh-not-authenticated', detail: 'run gh auth login' },
    });
    registerWorker(registry, 'wk', ROOT, dir);
    const out = await makeOpenPrTool(deps({ ghRunner: gh })).handler(callArgs({ worker_id: 'wk' }), ctx);
    expect(out.isError).toBe(true);
    expect(out.structuredContent?.code).toBe('gh-not-authenticated');
    expect(out.content[0]?.text).toContain('gh auth login');
  });

  it('errors when there is no GitHub remote', async () => {
    const { gh } = makeFakeGh({ hasRemote: false });
    registerWorker(registry, 'wk', ROOT, dir);
    const out = await makeOpenPrTool(deps({ ghRunner: gh })).handler(callArgs({ worker_id: 'wk' }), ctx);
    expect(out.isError).toBe(true);
    expect(out.structuredContent?.code).toBe('no-github-remote');
  });

  it('errors when the worktree IS the project root', async () => {
    // Register the project with path === the git dir, and the worker worktree === same dir.
    projectStore.register({ id: 'p2', name: 'main-repo', path: dir, createdAt: '2026-06-01T00:00:00.000Z' });
    const record: WorkerRecord = {
      id: 'wk2',
      projectPath: dir,
      projectId: 'p2',
      taskId: null,
      worktreePath: dir,
      role: 'implementer',
      featureIntent: 'x',
      taskDescription: 'x',
      autonomyTier: 2,
      dependsOn: [],
      status: 'completed',
      createdAt: new Date().toISOString(),
      worker: stubWorker(),
      buffer: new CircularBuffer<StreamEvent>(10),
      auditAttempts: 0,
      detach: () => {},
    };
    registry.register(record);
    const out = await makeOpenPrTool(deps()).handler(callArgs({ worker_id: 'wk2' }), ctx);
    expect(out.isError).toBe(true);
    expect(out.content[0]?.text).toContain('distinct from the project root');
  });

  it('errors when the branch equals the base', async () => {
    registerWorker(registry, 'wk', ROOT, dir);
    const out = await makeOpenPrTool(deps()).handler(callArgs({ worker_id: 'wk', base: 'feature/x' }), ctx);
    expect(out.isError).toBe(true);
    expect(out.structuredContent?.code).toBe('branch-equals-base');
  });

  it('errors when the pre-PR push is rejected', async () => {
    const fakePush = makeFakePush();
    fakePush.setThrow(new PushRejectedError('rejected', 'non-fast-forward', 1));
    registerWorker(registry, 'wk', ROOT, dir);
    const out = await makeOpenPrTool(deps({ push: fakePush.push })).handler(callArgs({ worker_id: 'wk' }), ctx);
    expect(out.isError).toBe(true);
    expect(out.structuredContent?.code).toBe('push-rejected');
  });

  it('pushes, generates content, and opens the PR (happy path)', async () => {
    const { gh, createInputs } = makeFakeGh({
      createResult: { url: 'https://github.com/o/r/pull/55', alreadyExisted: false },
    });
    const fakePush = makeFakePush();
    const fakeGen = makeFakeGenerate();
    registerWorker(registry, 'wk', ROOT, dir);

    const out = await makeOpenPrTool(
      deps({ ghRunner: gh, push: fakePush.push, generate: fakeGen.generate }),
    ).handler(callArgs({ worker_id: 'wk' }), ctx);

    expect(out.isError).toBeUndefined();
    expect(fakePush.calls).toHaveLength(1);
    expect(fakePush.calls[0]?.branch).toBe('feature/x');
    expect(fakeGen.calls).toHaveLength(1);
    expect(fakeGen.calls[0]?.baseRef).toBe(baseBranch); // local base resolved (no origin)
    expect(createInputs).toHaveLength(1);
    expect(createInputs[0]).toMatchObject({
      base: baseBranch,
      head: 'feature/x',
      title: 'gen: title',
      body: '## Gen\nbody',
      draft: false,
    });
    expect(out.structuredContent).toMatchObject({
      url: 'https://github.com/o/r/pull/55',
      base: baseBranch,
      head: 'feature/x',
      description_source: 'llm',
      already_existed: false,
    });
  });

  it('honors a title-only override but still generates the body', async () => {
    const { gh, createInputs } = makeFakeGh({});
    const fakeGen = makeFakeGenerate();
    registerWorker(registry, 'wk', ROOT, dir);
    await makeOpenPrTool(deps({ ghRunner: gh, generate: fakeGen.generate })).handler(
      callArgs({ worker_id: 'wk', title: 'custom title' }),
      ctx,
    );
    expect(fakeGen.calls).toHaveLength(1);
    expect(createInputs[0]?.title).toBe('custom title');
    expect(createInputs[0]?.body).toBe('## Gen\nbody');
  });

  it('skips generation entirely when both title and body are supplied', async () => {
    const { gh, createInputs } = makeFakeGh({});
    const fakeGen = makeFakeGenerate();
    registerWorker(registry, 'wk', ROOT, dir);
    const out = await makeOpenPrTool(deps({ ghRunner: gh, generate: fakeGen.generate })).handler(
      callArgs({ worker_id: 'wk', title: 'T', body: 'B' }),
      ctx,
    );
    expect(fakeGen.calls).toHaveLength(0);
    expect(createInputs[0]).toMatchObject({ title: 'T', body: 'B' });
    expect(out.structuredContent?.description_source).toBe('override');
  });

  it('passes the draft flag through', async () => {
    const { gh, createInputs } = makeFakeGh({});
    registerWorker(registry, 'wk', ROOT, dir);
    const out = await makeOpenPrTool(deps({ ghRunner: gh })).handler(
      callArgs({ worker_id: 'wk', draft: true }),
      ctx,
    );
    expect(createInputs[0]?.draft).toBe(true);
    expect(out.structuredContent?.draft).toBe(true);
  });

  it('reports an already-existing PR distinctly', async () => {
    const { gh } = makeFakeGh({
      createResult: { url: 'https://github.com/o/r/pull/3', alreadyExisted: true },
    });
    registerWorker(registry, 'wk', ROOT, dir);
    const out = await makeOpenPrTool(deps({ ghRunner: gh })).handler(callArgs({ worker_id: 'wk' }), ctx);
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent?.already_existed).toBe(true);
    expect(out.content[0]?.text).toContain('already exists');
  });
});
