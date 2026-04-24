import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = path.join(projectRoot, 'dist', 'index.js');
const distMigrations = path.join(projectRoot, 'dist', 'migrations');
const distAvailable = existsSync(distEntry) && existsSync(distMigrations);

if (!distAvailable) {
  console.warn(
    `[2b1 scenario] ${distEntry} or ${distMigrations} missing — run pnpm build.`,
  );
}

interface SpawnedServer {
  readonly client: Client;
  readonly transport: StdioClientTransport;
  readonly dispose: () => Promise<void>;
}

async function spawnMcpServer(dbFile: string): Promise<SpawnedServer> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry, 'mcp-server'],
    env: {
      ...process.env,
      SYMPHONY_DB_FILE: dbFile,
    } as Record<string, string>,
  });
  const client = new Client({ name: '2b1-scenario-client', version: '0.0.0' });
  await client.connect(transport);
  const dispose = async (): Promise<void> => {
    await client.close().catch(() => {});
    // transport.close is a no-op after client.close closes it, but keep
    // it defensive so a test failure path still tears the child down.
    await transport.close().catch(() => {});
  };
  return { client, transport, dispose };
}

describe.skipIf(!distAvailable)('Phase 2B.1 production scenario — real mcp-server + SQLite persistence', () => {
  let sandbox: string;
  let dbFile: string;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-2b1-'));
    dbFile = path.join(sandbox, 'symphony.db');
  });

  afterEach(() => {
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore Win32 SQLite file-handle retention */
    }
  });

  it(
    'creates a task in process A, kills it, and process B reads it from the persisted DB',
    async () => {
      // ----- process A: write -----
      const a = await spawnMcpServer(dbFile);
      try {
        const listA = await a.client.callTool({ name: 'list_projects', arguments: {} });
        const scA = listA.structuredContent as { projects: Array<{ name: string }> };
        expect(scA.projects.length).toBeGreaterThanOrEqual(1);

        const createRes = await a.client.callTool({
          name: 'create_task',
          arguments: {
            project: scA.projects[0]!.name,
            description: 'persist across subprocess boundary',
            priority: 7,
          },
        });
        const created = createRes.structuredContent as { id: string };
        expect(created.id).toMatch(/^tk-/);

        await a.dispose();

        // DB file should exist on disk with non-zero bytes.
        expect(existsSync(dbFile)).toBe(true);
        expect(statSync(dbFile).size).toBeGreaterThan(0);

        // ----- process B: read -----
        const b = await spawnMcpServer(dbFile);
        try {
          const listB = await b.client.callTool({
            name: 'list_tasks',
            arguments: { project: scA.projects[0]!.name },
          });
          const scB = listB.structuredContent as {
            tasks: Array<{ id: string; description: string; priority: number }>;
          };
          expect(scB.tasks).toHaveLength(1);
          expect(scB.tasks[0]!.id).toBe(created.id);
          expect(scB.tasks[0]!.description).toBe('persist across subprocess boundary');
          expect(scB.tasks[0]!.priority).toBe(7);
        } finally {
          await b.dispose();
        }
      } catch (err) {
        await a.dispose();
        throw err;
      }
    },
    60_000,
  );
});
