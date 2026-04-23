import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';

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

async function initRepo(repoPath: string): Promise<void> {
  const git = async (...args: string[]) => {
    await execFileAsync('git', args, { cwd: repoPath });
  };
  await git('init', '--initial-branch=main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Symphony Scenario 2a2');
  await git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# Phase 2A.2 scenario\n');
  await git('add', '.');
  await git('commit', '-m', 'init');
}

async function waitFor(pred: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return pred();
}

if (!claudeAvailable) {
  console.warn(
    '[2a2 scenario] `claude --version` unavailable — real-claude scenario will skip. Install the CLI and re-run locally to exercise Gate 3.',
  );
}

describe('Phase 2A.2 production scenario — MCP client drives worker-lifecycle tools', () => {
  let sandbox: string;
  let projectPath: string;
  let handle: OrchestratorServerHandle | null = null;
  let client: Client | null = null;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-2a2-'));
    projectPath = path.join(sandbox, 'repo');
    if (!existsSync(projectPath)) {
      mkdirSync(projectPath, { recursive: true });
    }
    await initRepo(projectPath);
  });

  afterEach(async () => {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    try {
      await handle?.close();
    } catch {
      /* ignore */
    }
    client = null;
    handle = null;
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it.skipIf(!claudeAvailable)(
    'spawn_worker → list_workers → get_worker_output → kill_worker',
    async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      handle = await startOrchestratorServer({
        transport: serverTransport,
        initialMode: 'act',
        defaultProjectPath: projectPath,
      });
      client = new Client({ name: 'scenario-2a2', version: '0.0.0' });
      await client.connect(clientTransport);

      const spawn = await client.callTool({
        name: 'spawn_worker',
        arguments: {
          task_description:
            'Print the single word READY and nothing else. Do not use any tools. Do not emit a structured completion block.',
          role: 'implementer',
        },
      });
      expect(spawn.isError).toBeFalsy();
      const s = spawn.structuredContent as {
        id: string;
        worktreePath: string;
        featureIntent: string;
      };
      expect(s.id).toMatch(/^wk-/);
      expect(path.resolve(s.worktreePath).startsWith(path.resolve(projectPath))).toBe(true);
      expect(s.featureIntent.length).toBeGreaterThan(0);

      // While the worker boots, list_workers should include the new id
      const list = await client.callTool({ name: 'list_workers', arguments: {} });
      const listContent = list.structuredContent as {
        workers: Array<{ id: string; status: string }>;
      };
      const entry = listContent.workers.find((w) => w.id === s.id);
      expect(entry).toBeDefined();
      expect(['spawning', 'running']).toContain(entry?.status ?? '');

      // Wait for the worker to produce a result event (buffer observes it via
      // the lifecycle event tap). Multi-turn workers with keepStdinOpen=true
      // do NOT auto-exit; Maestro cleans up via kill_worker. That's what we
      // test next.
      const record = handle.workerRegistry.get(s.id);
      expect(record).toBeDefined();
      const sawResult = await waitFor(
        () => record!.buffer.tail(record!.buffer.size()).some((e) => e.type === 'result'),
        90_000,
      );
      expect(sawResult).toBe(true);

      const output = await client.callTool({
        name: 'get_worker_output',
        arguments: { worker_id: s.id, lines: 200 },
      });
      expect(output.isError).toBeFalsy();
      const outContent = output.structuredContent as {
        events: Array<{ type: string }>;
        total: number;
      };
      expect(outContent.total).toBeGreaterThan(0);
      expect(outContent.events.some((e) => e.type === 'parse_error')).toBe(false);
      expect(outContent.events.some((e) => e.type === 'result')).toBe(true);

      // kill_worker terminates the multi-turn worker and the registry should
      // transition to a terminal status after the process exits.
      const kill = await client.callTool({
        name: 'kill_worker',
        arguments: { worker_id: s.id, reason: 'scenario-complete' },
      });
      expect(kill.isError).toBeFalsy();

      const exit = await record!.worker.waitForExit();
      expect(['completed', 'killed', 'failed']).toContain(exit.status);

      const listAfter = await client.callTool({ name: 'list_workers', arguments: {} });
      const listAfterContent = listAfter.structuredContent as {
        workers: Array<{ id: string; status: string }>;
      };
      const terminal = listAfterContent.workers.find((w) => w.id === s.id);
      expect(['completed', 'killed', 'failed']).toContain(terminal?.status ?? '');
    },
    150_000,
  );
});
