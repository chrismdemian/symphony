import { spawn, type ChildProcessWithoutNullStreams, execFile, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcClient } from '../../src/rpc/client.js';
import type { SymphonyRouter } from '../../src/rpc/router-impl.js';
import { WorkerManager, type SpawnFn } from '../../src/workers/manager.js';
import {
  MaestroProcess,
  type MaestroEvent,
  type MaestroPromptVars,
} from '../../src/orchestrator/maestro/index.js';

const execFileAsync = promisify(execFile);
const isWin32 = process.platform === 'win32';
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const FAKE_INTERACTIVE = path.join(REPO_ROOT, 'tests', 'helpers', 'fake-claude-interactive.mjs');

// Real-Claude reproducer is opt-in via env to keep CI deterministic.
// Local Sub-Phase Acceptance Gate 3 (production scenario, real claude)
// requires running with `SYMPHONY_2C1_REAL_CLAUDE=1` set.
const realClaudeOptIn = process.env.SYMPHONY_2C1_REAL_CLAUDE === '1';
const claudeAvailable = realClaudeOptIn && detectClaude();

function detectClaude(): boolean {
  try {
    const result = spawnSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5_000,
      shell: isWin32,
    });
    return result.status === 0 && (result.stdout?.trim().length ?? 0) > 0;
  } catch {
    return false;
  }
}

if (!claudeAvailable) {
  console.warn(
    '[2c1 scenario] real-Claude reproducer skipped (set SYMPHONY_2C1_REAL_CLAUDE=1 to run). The always-run path still exercises MaestroProcess + RPC + fake-claude.',
  );
}

interface RpcAdvert {
  event: 'symphony.rpc.ready';
  host: string;
  port: number;
  tokenFile: string | null;
}

interface OrchestratorHandle {
  child: ChildProcessWithoutNullStreams;
  advert: RpcAdvert;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function spawnOrchestrator(opts: { cwd: string; tokenFile: string }): Promise<OrchestratorHandle> {
  const tsxBin = isWin32
    ? path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx.cmd')
    : path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
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
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
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
  return { child, advert, exit };
}

async function shutdownOrchestrator(handle: OrchestratorHandle): Promise<void> {
  if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  handle.child.kill('SIGTERM');
  // Win32 SIGKILL fallback — see manager.ts grace period semantics.
  const timeout = setTimeout(() => {
    try {
      handle.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, 8_000);
  try {
    await handle.exit;
  } finally {
    clearTimeout(timeout);
  }
}

function fakeClaudeSpawner(scenario: string): SpawnFn {
  return (_command: string, _args: readonly string[], options): ChildProcessWithoutNullStreams =>
    spawn(process.execPath, [FAKE_INTERACTIVE, scenario], options) as ChildProcessWithoutNullStreams;
}

function promptVars(): MaestroPromptVars {
  return {
    projectName: 'symphony-2c1',
    registeredProjects: 'symphony-2c1',
    workersInFlight: '(none)',
    currentMode: 'PLAN',
    autonomyDefault: '2',
    planModeRequired: false,
    previewCommand: '',
    availableTools: '',
    maestroWarmth: '',
  };
}

const FIXTURE_PROMPT_BODY = `# fixture
## BEGIN PROMPT
You are Maestro. Active project: {project_name}. Mode: {current_mode}.
## END PROMPT
`;

describe('Phase 2C.1 production scenario — MaestroProcess + MCP attachment', () => {
  let sandbox: string;
  let home: string;
  let promptsDir: string;
  let orch: OrchestratorHandle | null = null;
  let rpc: RpcClient<SymphonyRouter> | null = null;
  let mgr: WorkerManager | null = null;
  let maestro: MaestroProcess | null = null;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-2c1-'));
    home = path.join(sandbox, 'home');
    mkdirSync(home, { recursive: true });
    promptsDir = path.join(sandbox, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(path.join(promptsDir, 'maestro-system-prompt-v1.md'), FIXTURE_PROMPT_BODY, 'utf8');
  });

  afterEach(async () => {
    try {
      await maestro?.kill().catch(() => undefined);
    } catch {
      // ignore
    }
    try {
      await mgr?.shutdown();
    } catch {
      // ignore
    }
    try {
      await rpc?.close();
    } catch {
      // ignore
    }
    try {
      if (orch !== null) await shutdownOrchestrator(orch);
    } catch {
      // ignore
    }
    maestro = null;
    mgr = null;
    rpc = null;
    orch = null;
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('writes CLAUDE.md + mcp-config to disk; RPC client reaches orchestrator; MaestroProcess emits typed events through fake-claude', async () => {
    const tokenFile = path.join(sandbox, 'rpc.json');
    orch = await spawnOrchestrator({ cwd: sandbox, tokenFile });

    rpc = await RpcClient.connect<SymphonyRouter>({
      url: `ws://${orch.advert.host}:${orch.advert.port}/`,
      token: readFileSync(tokenFile, 'utf8').match(/"token"\s*:\s*"([^"]+)"/)![1]!,
    });
    const projects = await rpc.call.projects.list({});
    // `projects.list` returns `ProjectSnapshot[]` directly per Phase 2B.2 router.
    // Empty in this scenario (orchestrator was booted with no project registered),
    // but the RPC round-trip alone proves the parent → mcp-server channel works.
    expect(Array.isArray(projects)).toBe(true);

    mgr = new WorkerManager({
      claudeConfigPath: path.join(home, '.claude.json'),
      claudeHome: home,
      spawn: fakeClaudeSpawner('maestro-process'),
    });
    maestro = new MaestroProcess({
      workerManager: mgr,
      home,
      promptsDir,
      cliEntryPath: path.join(REPO_ROOT, 'src', 'index.ts'),
      nodeBinary: process.execPath,
    });
    const startResult = await maestro.start({ promptVars: promptVars() });

    expect(startResult.systemInit.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(startResult.workspace.cwd).toBe(path.join(home, '.symphony', 'maestro'));

    const claudeMd = readFileSync(startResult.workspace.claudeMdPath, 'utf8');
    expect(claudeMd).toContain('Active project: symphony-2c1');

    const mcpConfig = JSON.parse(readFileSync(startResult.mcpConfigPath, 'utf8')) as {
      mcpServers: { symphony: { command: string; args: string[] } };
    };
    expect(mcpConfig.mcpServers.symphony.args).toEqual([
      path.join(REPO_ROOT, 'src', 'index.ts'),
      'mcp-server',
    ]);

    // Drive a turn through the fake-claude scenario and assert the typed
    // event pipeline forwards everything end-to-end.
    const collector = (async (): Promise<MaestroEvent[]> => {
      const out: MaestroEvent[] = [];
      const ref = maestro!;
      for await (const event of ref.events()) {
        out.push(event);
        if (event.type === 'turn_completed') break;
      }
      return out;
    })();
    await Promise.resolve();
    maestro.sendUserMessage('first turn please');
    const events = await collector;
    const types = events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'turn_started',
        'assistant_text',
        'tool_use',
        'tool_result',
        'turn_completed',
      ]),
    );
    const toolUse = events.find((e) => e.type === 'tool_use');
    expect(toolUse?.type).toBe('tool_use');
    if (toolUse?.type === 'tool_use') {
      expect(toolUse.name).toBe('spawn_worker');
    }
  }, 60_000);

  it.skipIf(!claudeAvailable)(
    'real Claude binary spawned via MaestroProcess sees the Symphony MCP server',
    async () => {
      const tokenFile = path.join(sandbox, 'rpc.json');
      orch = await spawnOrchestrator({ cwd: sandbox, tokenFile });

      mgr = new WorkerManager({
        claudeConfigPath: path.join(home, '.claude.json'),
        claudeHome: home,
        // No `spawn:` override — uses real `claude` from PATH.
      });
      maestro = new MaestroProcess({
        workerManager: mgr,
        home,
        promptsDir,
        cliEntryPath: path.join(REPO_ROOT, 'src', 'index.ts'),
        nodeBinary: process.execPath,
      });
      const startResult = await maestro.start({ promptVars: promptVars() });
      expect(startResult.systemInit.sessionId).toMatch(/^[0-9a-f-]{36}$/);

      // Send a directive that should provoke `list_workers`. The fixture
      // CLAUDE.md is intentionally tiny so Maestro stays focused.
      const collector = (async (): Promise<MaestroEvent[]> => {
        const out: MaestroEvent[] = [];
        const deadline = Date.now() + 90_000;
        const ref = maestro!;
        for await (const event of ref.events()) {
          out.push(event);
          if (event.type === 'turn_completed') break;
          if (Date.now() > deadline) break;
        }
        return out;
      })();
      await Promise.resolve();
      maestro.sendUserMessage(
        'Use the list_workers MCP tool exactly once and report how many workers you see. Do nothing else.',
      );
      const events = await collector;
      const types = new Set(events.map((e) => e.type));
      expect(types.has('assistant_text')).toBe(true);
      expect(types.has('turn_completed')).toBe(true);
      const toolCalls = events
        .filter((e): e is Extract<MaestroEvent, { type: 'tool_use' }> => e.type === 'tool_use')
        .map((e) => e.name);
      expect(toolCalls).toContain('list_workers');
    },
    150_000,
  );

  it('start() throws cleanly when the prompts dir is missing the v1 file', async () => {
    rmSync(path.join(promptsDir, 'maestro-system-prompt-v1.md'));
    mgr = new WorkerManager({
      claudeConfigPath: path.join(home, '.claude.json'),
      claudeHome: home,
      spawn: fakeClaudeSpawner('maestro-process'),
    });
    maestro = new MaestroProcess({
      workerManager: mgr,
      home,
      promptsDir,
      cliEntryPath: path.join(REPO_ROOT, 'src', 'index.ts'),
    });
    await expect(maestro.start({ promptVars: promptVars() })).rejects.toThrow(/Maestro v1 prompt/);
  });
});

// Suppress unused-locals warning for execFileAsync when the gated test skips.
void execFileAsync;
