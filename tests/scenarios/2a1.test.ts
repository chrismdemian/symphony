import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkerManager } from '../../src/workers/manager.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distEntry = path.join(projectRoot, 'dist', 'index.js');

const claudeAvailable = detectClaude();
const distAvailable = existsSync(distEntry);

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

async function drain(worker: Worker): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of worker.events) events.push(ev);
  return events;
}

async function initRepo(repoPath: string): Promise<void> {
  const git = async (...args: string[]) => {
    await execFileAsync('git', args, { cwd: repoPath });
  };
  await git('init', '--initial-branch=main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Symphony Scenario');
  await git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# Phase 2A.1 scenario\n');
  await git('add', '.');
  await git('commit', '-m', 'init');
}

if (!claudeAvailable) {
  console.warn(
    '[2a1 scenario] `claude --version` unavailable — real-claude scenario will skip. Install the CLI and re-run locally to exercise Gate 3.',
  );
}

if (!distAvailable && claudeAvailable) {
  console.warn(
    `[2a1 scenario] ${distEntry} is missing — run \`pnpm build\` before the scenario suite. Scenario will skip.`,
  );
}

describe('Phase 2A.1 production scenario — real claude -p invokes symphony MCP think tool', () => {
  let sandbox: string;
  let projectPath: string;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-2a1-'));
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

  it.skipIf(!claudeAvailable || !distAvailable)(
    'worker connects to symphony MCP server, calls think, receives dispatched result',
    async () => {
      const mcpConfig = {
        mcpServers: {
          symphony: {
            command: process.execPath,
            args: [distEntry, 'mcp-server'],
          },
        },
      };
      const mcpConfigPath = path.join(projectPath, '.symphony-mcp.json');
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

      const prompt = [
        'You have access to an MCP server named `symphony` that exposes a tool called `think`.',
        'Call the `think` tool EXACTLY ONCE with this payload:',
        '{"ledger": {"is_plan_complete": false, "is_making_progress": true, "workers_in_flight": [], "blockers": [], "next_action": "scenario probe", "reason": "2a1 smoke test"}}',
        'Then, after the tool_result comes back, emit one structured completion fence (```json ... ```) with EXACTLY this shape and nothing else after it:',
        '{',
        '  "did": ["invoked symphony.think"],',
        '  "skipped": [],',
        '  "blockers": [],',
        '  "open_questions": [],',
        '  "audit": "PASS",',
        '  "cite": ["symphony.think"],',
        '  "tests_run": [],',
        '  "preview_url": null',
        '}',
      ].join('\n');

      const mgr = new WorkerManager();
      try {
        const worker = await mgr.spawn({
          id: 'scenario-2a1',
          cwd: projectPath,
          deterministicUuidInput: `scenario-2a1::${projectPath}`,
          prompt,
          mcpConfigPath,
          timeoutMs: 180_000,
        });
        const events = await drain(worker);
        const exit = await worker.waitForExit();

        expect(exit.status).toBe('completed');
        expect(exit.exitCode).toBe(0);
        expect(events.some((e) => e.type === 'parse_error')).toBe(false);

        const init = events.find((e) => e.type === 'system_init');
        if (init?.type !== 'system_init') throw new Error('expected system_init event');
        const mcpStatuses = init.mcpServers ?? [];
        const symphonyEntry = mcpStatuses.find((m) => m.name === 'symphony');
        expect(symphonyEntry).toBeDefined();
        expect(symphonyEntry?.status.toLowerCase()).toMatch(/connected|ready|ok/);

        const toolUses = events.filter((e) => e.type === 'tool_use');
        const symphonyCall = toolUses.find(
          (e) => e.type === 'tool_use' && /think/i.test(e.name) && /symphony/i.test(e.name),
        );
        expect(symphonyCall).toBeDefined();

        const toolResults = events.filter((e) => e.type === 'tool_result');
        if (process.env.SYMPHONY_SCENARIO_DEBUG === '1') {
          for (const r of toolResults) console.log('[tool_result]', JSON.stringify(r));
        }
        const dispatchedResult = toolResults.find(
          (e) =>
            e.type === 'tool_result' &&
            (/ledger recorded/i.test(JSON.stringify(e)) || /recorded/i.test(JSON.stringify(e))),
        );
        expect(dispatchedResult).toBeDefined();

        const result = events.find((e) => e.type === 'result');
        if (result?.type !== 'result') throw new Error('expected result event');
        expect(result.sessionId).toBeTruthy();

        const completion = events.find((e) => e.type === 'structured_completion');
        if (completion?.type !== 'structured_completion') {
          throw new Error('expected structured_completion event');
        }
        expect(completion.report.audit).toBe('PASS');
      } finally {
        await mgr.shutdown();
      }
    },
    240_000,
  );
});
