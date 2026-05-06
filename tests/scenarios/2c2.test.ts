import { spawn, type ChildProcessWithoutNullStreams, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { createInterface } from 'node:readline';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkerManager, type SpawnFn } from '../../src/workers/manager.js';
import {
  MaestroProcess,
  MaestroHookServer,
  installStopHook,
  uninstallStopHook,
  ensureMaestroWorkspace,
  type MaestroEvent,
  type MaestroPromptVars,
  type HookPayload,
} from '../../src/orchestrator/maestro/index.js';
import { MAESTRO_SESSION_UUID } from '../../src/orchestrator/maestro/session.js';

const isWin32 = process.platform === 'win32';
const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const FAKE_INTERACTIVE = path.join(REPO_ROOT, 'tests', 'helpers', 'fake-claude-interactive.mjs');

const realClaudeOptIn = process.env['SYMPHONY_2C2_REAL_CLAUDE'] === '1';
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
    '[2c2 scenario] real-Claude reproducer skipped (set SYMPHONY_2C2_REAL_CLAUDE=1 to run). ' +
      'The always-run path exercises Maestro + hook + fake-claude end-to-end.',
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
  exit: Promise<void>;
}

async function spawnOrchestrator(opts: {
  cwd: string;
  tokenFile: string;
}): Promise<OrchestratorHandle> {
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
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
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
        // non-JSON stderr line — ignore
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
  const timer = setTimeout(() => {
    try {
      handle.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, 8_000);
  try {
    await handle.exit;
  } finally {
    clearTimeout(timer);
  }
}

function fakeClaudeSpawner(scenario: string): SpawnFn {
  return (_command: string, _args: readonly string[], options): ChildProcessWithoutNullStreams =>
    spawn(process.execPath, [FAKE_INTERACTIVE, scenario], options) as ChildProcessWithoutNullStreams;
}

const FIXTURE_PROMPT_BODY = `# fixture
## BEGIN PROMPT
You are Maestro. Active project: {project_name}. Mode: {current_mode}.
## END PROMPT
`;

function makePromptVars(): MaestroPromptVars {
  return {
    projectName: 'symphony-2c2',
    registeredProjects: 'symphony-2c2',
    workersInFlight: '(none)',
    currentMode: 'PLAN',
    autonomyDefault: '1',
    planModeRequired: false,
    previewCommand: '',
    availableTools: '',
    maestroWarmth: '',
    modelMode: 'mixed',
  };
}

async function postToHook(
  port: number,
  token: string,
  body: Record<string, unknown>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/hook',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-symphony-hook-token': token,
          'x-symphony-hook-event': 'stop',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Phase 2C.2 production scenario — Stop hook + session resume + symphony start', () => {
  let sandbox: string;
  let home: string;
  let promptsDir: string;
  let orch: OrchestratorHandle | null = null;
  let mgr: WorkerManager | null = null;
  let maestro: MaestroProcess | null = null;
  let hookServer: MaestroHookServer | null = null;

  beforeEach(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-2c2-'));
    home = path.join(sandbox, 'home');
    mkdirSync(home, { recursive: true });
    promptsDir = path.join(sandbox, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      path.join(promptsDir, 'maestro-system-prompt-v1.md'),
      FIXTURE_PROMPT_BODY,
      'utf8',
    );
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
      await hookServer?.stop();
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
    hookServer = null;
    orch = null;
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('installs the Stop hook into Maestro workspace; HTTP POST surfaces an idle event; uninstall strips the entry', async () => {
    const tokenFile = path.join(sandbox, 'rpc.json');
    orch = await spawnOrchestrator({ cwd: sandbox, tokenFile });

    mgr = new WorkerManager({
      claudeConfigPath: path.join(home, '.claude.json'),
      claudeHome: home,
      spawn: fakeClaudeSpawner('maestro-stop-hook'),
    });
    hookServer = new MaestroHookServer();
    const { port: hookPort, token: hookToken } = await hookServer.start();

    const workspace = await ensureMaestroWorkspace({ home });
    const claudeDir = path.join(workspace.cwd, '.claude');
    await installStopHook({ claudeDir, port: hookPort });

    const settingsPath = path.join(claudeDir, 'settings.local.json');
    const settingsBefore = readFileSync(settingsPath, 'utf8');
    expect(settingsBefore).toContain('SYMPHONY_HOOK_PORT');
    expect(settingsBefore).toContain('curl -sf -X POST');
    expect(settingsBefore).toContain('|| true');

    maestro = new MaestroProcess({
      workerManager: mgr,
      home,
      promptsDir,
      cliEntryPath: path.join(REPO_ROOT, 'src', 'index.ts'),
      nodeBinary: process.execPath,
    });

    // Wire hook → maestro before start so injected events can show up in events().
    hookServer.on('stop', (payload: HookPayload) => {
      maestro!.injectIdle(payload);
    });

    const startResult = await maestro.start({
      promptVars: makePromptVars(),
      extraEnv: {
        SYMPHONY_HOOK_PORT: String(hookPort),
        SYMPHONY_HOOK_TOKEN: hookToken,
      },
    });
    expect(startResult.systemInit.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // Drive a turn and assert the typed event pipeline + idle injection.
    // Two iterators in parallel: `events` collects the full stream until
    // `idle` lands; `turnGate` watches for `turn_completed` so we can fire
    // the Stop hook AFTER the result has streamed (matches real-Claude
    // ordering — Stop hook runs after the model's turn). The fake-claude
    // scenario sleeps 8s post-result so the worker is still alive when we
    // POST to the hook server.
    const ref = maestro;
    const events: MaestroEvent[] = [];
    const collectorDone = new Promise<void>((resolve) => {
      void (async () => {
        const deadline = Date.now() + 15_000;
        for await (const event of ref.events()) {
          events.push(event);
          if (event.type === 'idle') {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            resolve();
            return;
          }
        }
        resolve();
      })();
    });
    const turnGate = new Promise<void>((resolve) => {
      void (async () => {
        const deadline = Date.now() + 10_000;
        for await (const event of ref.events()) {
          if (event.type === 'turn_completed') {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            resolve();
            return;
          }
        }
        resolve();
      })();
    });

    await Promise.resolve();
    maestro.sendUserMessage('first user message');
    await turnGate;

    const status = await postToHook(hookPort, hookToken, {
      session_id: startResult.systemInit.sessionId,
      transcript_path: '/fake/transcript.jsonl',
      stop_reason: 'end_turn',
      hook_event_name: 'Stop',
    });
    expect(status).toBe(200);

    await collectorDone;
    const idle = events.find((e) => e.type === 'idle');
    expect(idle).toBeDefined();
    if (idle?.type === 'idle') {
      expect(idle.payload.sessionId).toBe(startResult.systemInit.sessionId);
      expect(idle.payload.stopReason).toBe('end_turn');
      expect(idle.payload.transcriptPath).toBe('/fake/transcript.jsonl');
    }
    const types = new Set(events.map((e) => e.type));
    expect(types.has('assistant_text')).toBe(true);
    expect(types.has('turn_completed')).toBe(true);
    expect(types.has('idle')).toBe(true);

    // Uninstall — settings file should no longer contain the marker.
    await uninstallStopHook({ claudeDir });
    const settingsAfter = readFileSync(settingsPath, 'utf8');
    expect(settingsAfter).not.toContain('SYMPHONY_HOOK_PORT');
  }, 60_000);

  it('rejects POSTs with a wrong token while the hook is live', async () => {
    hookServer = new MaestroHookServer({ token: 'right' });
    const { port } = await hookServer.start();
    const status = await postToHook(port, 'wrong', { hook_event_name: 'Stop' });
    expect(status).toBe(403);
  });

  it.skipIf(!claudeAvailable)(
    'real Claude binary across two boots: same MAESTRO_SESSION_UUID resumed; Stop hook fires naturally; settings.local.json clean after each boot',
    async () => {
      const tokenFile = path.join(sandbox, 'rpc.json');
      orch = await spawnOrchestrator({ cwd: sandbox, tokenFile });

      // BOOT 1
      let boot1SessionId: string | undefined;
      {
        mgr = new WorkerManager({
          claudeConfigPath: path.join(home, '.claude.json'),
          claudeHome: home,
        });
        hookServer = new MaestroHookServer();
        const { port: hookPort, token: hookToken } = await hookServer.start();
        const workspace = await ensureMaestroWorkspace({ home });
        const claudeDir = path.join(workspace.cwd, '.claude');
        await installStopHook({ claudeDir, port: hookPort });

        maestro = new MaestroProcess({
          workerManager: mgr,
          home,
          promptsDir,
          cliEntryPath: path.join(REPO_ROOT, 'src', 'index.ts'),
          nodeBinary: process.execPath,
        });
        hookServer.on('stop', (payload: HookPayload) => {
          maestro!.injectIdle(payload);
        });

        const startResult = await maestro.start({
          promptVars: makePromptVars(),
          extraEnv: {
            SYMPHONY_HOOK_PORT: String(hookPort),
            SYMPHONY_HOOK_TOKEN: hookToken,
          },
        });
        boot1SessionId = startResult.systemInit.sessionId;
        // The deterministic sentinel UUID must surface on first boot.
        expect(boot1SessionId).toBe(MAESTRO_SESSION_UUID);

        const ref = maestro;
        const collector = (async (): Promise<MaestroEvent[]> => {
          const out: MaestroEvent[] = [];
          const deadline = Date.now() + 90_000;
          for await (const event of ref.events()) {
            out.push(event);
            if (event.type === 'idle') return out;
            if (Date.now() > deadline) return out;
          }
          return out;
        })();
        await Promise.resolve();
        maestro.sendUserMessage('Reply with literally the word OK and nothing else.');

        const events = await collector;
        expect(events.some((e) => e.type === 'idle')).toBe(true);

        await maestro.kill();
        await mgr.shutdown();
        await hookServer.stop();
        await uninstallStopHook({ claudeDir });
        maestro = null;
        mgr = null;
        hookServer = null;
        const settingsAfter = readFileSync(
          path.join(claudeDir, 'settings.local.json'),
          'utf8',
        );
        expect(settingsAfter).not.toContain('SYMPHONY_HOOK_PORT');
      }

      // BOOT 2 — same `home`, expect the same sessionId via deterministic resume.
      {
        mgr = new WorkerManager({
          claudeConfigPath: path.join(home, '.claude.json'),
          claudeHome: home,
        });
        hookServer = new MaestroHookServer();
        const { port: hookPort, token: hookToken } = await hookServer.start();
        const workspace = await ensureMaestroWorkspace({ home });
        const claudeDir = path.join(workspace.cwd, '.claude');
        await installStopHook({ claudeDir, port: hookPort });

        maestro = new MaestroProcess({
          workerManager: mgr,
          home,
          promptsDir,
          cliEntryPath: path.join(REPO_ROOT, 'src', 'index.ts'),
          nodeBinary: process.execPath,
        });
        const startResult = await maestro.start({
          promptVars: makePromptVars(),
          extraEnv: {
            SYMPHONY_HOOK_PORT: String(hookPort),
            SYMPHONY_HOOK_TOKEN: hookToken,
          },
        });
        expect(startResult.systemInit.sessionId).toBe(boot1SessionId);
      }
    },
    240_000,
  );
});
