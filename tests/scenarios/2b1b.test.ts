import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Database as BetterSqlite3Database } from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  startOrchestratorServer,
  SymphonyDatabase,
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
  await git('config', 'user.name', 'Symphony Scenario 2b1b');
  await git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# Phase 2B.1b scenario\n');
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
    '[2b1b scenario] `claude --version` unavailable — real-claude scenario will skip. Install the CLI and re-run locally to exercise Gate 3.',
  );
}

interface WorkerRow {
  id: string;
  status: string;
  session_id: string | null;
  worktree_path: string;
  completed_at: string | null;
}

function readWorkerRow(db: BetterSqlite3Database, id: string): WorkerRow | undefined {
  return db
    .prepare(
      `SELECT id, status, session_id, worktree_path, completed_at FROM workers WHERE id = ?`,
    )
    .get(id) as WorkerRow | undefined;
}

describe('Phase 2B.1b production scenario — crash recovery across orchestrator restarts', () => {
  let sandbox: string;
  let projectPath: string;
  let dbFile: string;
  let dbA: SymphonyDatabase | null = null;
  let dbB: SymphonyDatabase | null = null;
  let handleA: OrchestratorServerHandle | null = null;
  let handleB: OrchestratorServerHandle | null = null;
  let clientA: Client | null = null;
  let clientB: Client | null = null;
  let orphanWorkerKilled = false;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-2b1b-'));
    projectPath = path.join(sandbox, 'repo');
    mkdirSync(projectPath, { recursive: true });
    dbFile = path.join(sandbox, 'symphony.db');
    await initRepo(projectPath);
    orphanWorkerKilled = false;
  });

  afterEach(async () => {
    // Order matters: close clients first so any in-flight RPC unwinds,
    // then orchestrator handles (which kill remaining workers + close
    // server). Then DB handles. Then rm.
    try {
      await clientA?.close();
    } catch {
      /* ignore */
    }
    try {
      await clientB?.close();
    } catch {
      /* ignore */
    }
    try {
      await handleA?.close();
    } catch {
      /* ignore */
    }
    try {
      await handleB?.close();
    } catch {
      /* ignore */
    }
    try {
      dbA?.close();
    } catch {
      /* ignore */
    }
    try {
      dbB?.close();
    } catch {
      /* ignore */
    }
    clientA = null;
    clientB = null;
    handleA = null;
    handleB = null;
    dbA = null;
    dbB = null;
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* Win32 SQLite/git file-handle retention */
    }
  });

  it.skipIf(!claudeAvailable)(
    'spawns a real worker, abandons orchestrator A, orchestrator B reconciles to crashed',
    async () => {
      // ---- Orchestrator A: spawn a real claude worker ----
      dbA = SymphonyDatabase.open({ filePath: dbFile });
      const [aClientTransport, aServerTransport] = InMemoryTransport.createLinkedPair();
      handleA = await startOrchestratorServer({
        transport: aServerTransport,
        initialMode: 'act',
        defaultProjectPath: projectPath,
        database: dbA,
      });
      clientA = new Client({ name: 'scenario-2b1b-A', version: '0.0.0' });
      await clientA.connect(aClientTransport);

      const spawn = await clientA.callTool({
        name: 'spawn_worker',
        arguments: {
          task_description:
            'Print the single word READY and nothing else. Do not use any tools. Do not emit a structured completion block.',
          role: 'implementer',
        },
      });
      expect(spawn.isError).toBeFalsy();
      const s = spawn.structuredContent as { id: string; worktreePath: string };
      expect(s.id).toMatch(/^wk-/);

      // Wait for the live registry to flip to 'running' (system_init event).
      const record = handleA.workerRegistry.get(s.id);
      expect(record).toBeDefined();
      const sawRunning = await waitFor(
        () => record!.status === 'running' && record!.sessionId !== undefined,
        90_000,
      );
      expect(sawRunning).toBe(true);

      // The persisted row should now show status='running' and session_id set.
      const rowMid = readWorkerRow(dbA.db, s.id);
      expect(rowMid).toBeDefined();
      expect(['spawning', 'running']).toContain(rowMid?.status);
      expect(rowMid?.session_id).toBeTruthy();
      const persistedSessionId = rowMid?.session_id;

      // Abandon orchestrator A: close the CLIENT only, do NOT call
      // handle.close(). The worker subprocess remains alive; we kill it
      // explicitly in afterEach via handle.close cascade.
      await clientA.close();
      clientA = null;

      // ---- Orchestrator B: fresh boot against same DB ----
      // Use a separate DB handle to model two orchestrator processes.
      dbB = SymphonyDatabase.open({ filePath: dbFile });
      const [bClientTransport, bServerTransport] = InMemoryTransport.createLinkedPair();
      handleB = await startOrchestratorServer({
        transport: bServerTransport,
        initialMode: 'act',
        defaultProjectPath: projectPath,
        database: dbB,
      });
      clientB = new Client({ name: 'scenario-2b1b-B', version: '0.0.0' });
      await clientB.connect(bClientTransport);

      // recoverFromStore ran during startOrchestratorServer. Read the row
      // back via dbB to confirm.
      const rowAfterRecover = readWorkerRow(dbB.db, s.id);
      expect(rowAfterRecover?.status).toBe('crashed');
      expect(rowAfterRecover?.session_id).toBe(persistedSessionId);
      expect(rowAfterRecover?.completed_at).toBeTruthy();

      // list_workers via the merge view should include the crashed worker.
      const list = await clientB.callTool({ name: 'list_workers', arguments: {} });
      const sc = list.structuredContent as {
        workers: Array<{ id: string; status: string; sessionId?: string }>;
      };
      const recovered = sc.workers.find((w) => w.id === s.id);
      expect(recovered?.status).toBe('crashed');
      expect(recovered?.sessionId).toBe(persistedSessionId);

      // global_status counts the crashed worker in totals + per-project bucket.
      const status = await clientB.callTool({
        name: 'global_status',
        arguments: {},
      });
      const statusSc = status.structuredContent as {
        totals: { workers: number; active: number };
        projects: Array<{ project: string; total: number; failed: number }>;
      };
      expect(statusSc.totals.workers).toBeGreaterThanOrEqual(1);
      expect(statusSc.totals.active).toBe(0);
      const bucket = statusSc.projects.find((p) => p.failed >= 1);
      expect(bucket).toBeDefined();

      // Mark that we abandoned a worker so afterEach's handleA.close()
      // (cascading kill_worker) is the cleanup path.
      orphanWorkerKilled = false;
      void orphanWorkerKilled;
    },
    180_000,
  );
});
