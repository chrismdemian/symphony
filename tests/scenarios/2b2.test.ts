import { spawn, type ChildProcessWithoutNullStreams, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcClient } from '../../src/rpc/client.js';
import type { SymphonyRouter } from '../../src/rpc/router-impl.js';

const execFileAsync = promisify(execFile);
const isWin32 = process.platform === 'win32';

interface RpcAdvert {
  event: 'symphony.rpc.ready';
  host: string;
  port: number;
  tokenFile: string | null;
}

async function initRepo(repoPath: string): Promise<void> {
  const git = async (...args: string[]) => {
    await execFileAsync('git', args, { cwd: repoPath });
  };
  await git('init', '--initial-branch=main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Symphony Scenario 2b2');
  await git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# Phase 2B.2 scenario\n');
  await git('add', '.');
  await git('commit', '-m', 'init');
}

interface SubprocessHandle {
  child: ChildProcessWithoutNullStreams;
  advert: RpcAdvert;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');

async function spawnOrchestrator(opts: {
  cwd: string;
  tokenFile: string;
}): Promise<SubprocessHandle> {
  const tsxBin = isWin32
    ? path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx.cmd')
    : path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  // Win32 .cmd shims need `shell: true` per Node child_process docs.
  const child = spawn(
    tsxBin,
    [
      path.join(REPO_ROOT, 'src', 'index.ts'),
      'mcp-server',
      '--in-memory',
      '--rpc-port',
      '0',
      '--rpc-token-file',
      opts.tokenFile,
    ],
    {
      cwd: opts.cwd,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin32,
    },
  );
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  // Drain stdout to keep the MCP transport happy (it reads from stdin).
  child.stdout.on('data', () => {});
  const advert = await new Promise<RpcAdvert>((resolve, reject) => {
    const rl = createInterface({ input: child.stderr });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error('symphony orchestrator did not advertise RPC within 30s'));
    }, 30_000);
    rl.on('line', (line) => {
      const idx = line.indexOf('{');
      if (idx < 0) return;
      try {
        const parsed = JSON.parse(line.slice(idx)) as RpcAdvert;
        if (parsed.event === 'symphony.rpc.ready') {
          clearTimeout(timeout);
          rl.removeAllListeners('line');
          resolve(parsed);
        }
      } catch {
        // Non-JSON stderr line — ignore.
      }
    });
    rl.once('close', () => {
      clearTimeout(timeout);
      reject(new Error('stderr closed before advert observed'));
    });
  });
  return { child, advert, exit: exitPromise };
}

async function awaitRemoval(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      statSync(filePath);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('Phase 2B.2 production scenario — typed RPC over real WebSocket', () => {
  let sandbox: string;
  let projectPath: string;
  let tokenFile: string;
  let handle: SubprocessHandle | undefined;
  let client: RpcClient<SymphonyRouter> | undefined;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-2b2-'));
    projectPath = path.join(sandbox, 'repo');
    mkdirSync(projectPath, { recursive: true });
    tokenFile = path.join(sandbox, 'rpc.json');
    await initRepo(projectPath);
  });

  afterEach(async () => {
    try {
      await client?.close();
    } catch {
      // already closed
    }
    if (handle !== undefined) {
      try {
        handle.child.kill('SIGTERM');
      } catch {
        // already dead
      }
      // Force kill if it lingers — Win32 ignores SIGTERM via tsx wrapper.
      const exitTimeout = setTimeout(() => {
        try {
          handle!.child.kill('SIGKILL');
        } catch {
          // already dead
        }
      }, 5_000);
      try {
        await handle.exit;
      } catch {
        // ignored
      }
      clearTimeout(exitTimeout);
    }
    handle = undefined;
    client = undefined;
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Win32 file-handle retention
    }
  });

  it(
    'advertises RPC, persists descriptor, serves typed RPC, cleans up on SIGTERM',
    { timeout: 120_000 },
    async () => {
      handle = await spawnOrchestrator({ cwd: projectPath, tokenFile });
      const { advert, child } = handle;
      expect(advert.event).toBe('symphony.rpc.ready');
      expect(advert.host).toBe('127.0.0.1');
      expect(Number.isInteger(advert.port)).toBe(true);
      expect(advert.port).toBeGreaterThan(0);
      expect(advert.tokenFile).toBe(tokenFile);

      // Descriptor file shape
      const desc = JSON.parse(readFileSync(tokenFile, 'utf8')) as {
        host: string;
        port: number;
        token: string;
        pid: number;
        startedAt: string;
      };
      expect(desc.host).toBe('127.0.0.1');
      expect(desc.port).toBe(advert.port);
      expect(desc.token).toMatch(/^[0-9a-f]{64}$/);
      // On Win32, `child.pid` is the cmd.exe wrapper, not the tsx Node process —
      // the descriptor records the inner pid, so just sanity-check it's a positive integer.
      if (isWin32) {
        expect(desc.pid).toBeGreaterThan(0);
      } else {
        expect(desc.pid).toBe(child.pid);
      }
      if (!isWin32) {
        const info = statSync(tokenFile);
        expect((info.mode & 0o777).toString(8)).toBe('600');
      }

      // RPC round-trip
      client = await RpcClient.connect<SymphonyRouter>({
        url: `ws://${desc.host}:${desc.port}`,
        token: desc.token,
        openTimeoutMs: 10_000,
      });
      const initial = await client.call.projects.list();
      expect(initial.length).toBeGreaterThanOrEqual(1);

      const registered = await client.call.projects.register({
        name: 'scenario-proj',
        path: '/tmp/scenario-2b2',
      });
      expect(registered.name).toBe('scenario-proj');
      const after = await client.call.projects.list();
      expect(after.map((p) => p.name)).toContain('scenario-proj');

      const task = await client.call.tasks.create({
        projectId: 'scenario-proj',
        description: 'demo',
      });
      expect(task.projectId).toBe(registered.id);
      const tasks = await client.call.tasks.list({ projectId: registered.id });
      expect(tasks.map((t) => t.id)).toContain(task.id);

      const modeSnap = await client.call.mode.get();
      expect(modeSnap.mode).toBe('plan');

      // Tear down: SIGTERM and confirm descriptor removal
      await client.close();
      client = undefined;
      child.kill('SIGTERM');
      await handle.exit;
      const removed = await awaitRemoval(tokenFile, 5_000);
      expect(removed).toBe(true);
    },
  );
});
