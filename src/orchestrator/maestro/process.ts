import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import type { Worker, WorkerExitInfo, StreamEvent } from '../../workers/types.js';
import type { WorkerManager } from '../../workers/manager.js';
import {
  composeMaestroPrompt,
  type MaestroPromptVars,
} from './prompt-composer.js';
import {
  ensureMaestroWorkspace,
  writeMaestroClaudeMd,
  MAESTRO_CLAUDE_MD_HEADER,
  type MaestroWorkspace,
} from './workspace.js';
import { writeMaestroMcpConfig } from './mcp-config.js';
import {
  resolveMaestroSession,
  type ResolvedMaestroSession,
} from './session.js';
import type { HookPayload } from './hook-server.js';

const MAESTRO_WORKER_ID = 'maestro';
const MAESTRO_SESSION_SENTINEL = 'maestro::global';
const HOOK_ENV_KEYS = ['SYMPHONY_HOOK_PORT', 'SYMPHONY_HOOK_TOKEN'] as const;
// Pre-subscribe backlog cap (audit M2). Small ring of recent events so an
// iterator attached after a synchronous emission still sees what it missed.
const EVENTS_BACKLOG_CAP = 256;
// Symbol-keyed internal channels (audit m2) — bare snake_case keys risked
// collision with future MaestroEvent type literals.
const ANY_EVENT = Symbol.for('symphony.maestro.anyEvent');
const STOPPED_EVENT = Symbol.for('symphony.maestro.stopped');

export class MaestroTurnInFlightError extends Error {
  constructor() {
    super(
      'MaestroProcess.sendUserMessage(): a previous turn is still streaming. ' +
        'Wait for `turn_completed` before sending another message.',
    );
    this.name = 'MaestroTurnInFlightError';
  }
}

export interface MaestroProcessDeps {
  workerManager: WorkerManager;
  /** CLI entry path Claude will spawn for MCP. Default: `process.argv[1]`. */
  cliEntryPath?: string;
  /** Override the Node binary the spawned mcp-server runs under. */
  nodeBinary?: string;
  /** Override `os.homedir()` (tests). */
  home?: string;
  /** When true, the spawned mcp-server uses in-memory stores (skips SQLite). */
  inMemory?: boolean;
  /** Optional explicit prompts dir (tests). */
  promptsDir?: string;
}

export interface MaestroStartInput {
  /**
   * Template-variable values for the Maestro CLAUDE.md. Supplied by the
   * launcher (`symphony start`) — Phase 2C.1 callers can pass placeholders;
   * `{registered_projects}` etc. land in 2C.2 once the launcher RPC-queries
   * the mcp-server child.
   */
  promptVars: MaestroPromptVars;
  /**
   * Extra env vars on top of `SYMPHONY_HOOK_*`. The Stop-hook env keys are
   * passed by the launcher in 2C.2; for 2C.1 this can be empty.
   */
  extraEnv?: Record<string, string>;
  /**
   * Forwarded to `WorkerConfig.signal`. Cancels mid-spawn.
   */
  signal?: AbortSignal;
}

export interface MaestroStartResult {
  workspace: MaestroWorkspace;
  session: ResolvedMaestroSession;
  /** Absolute path to the generated mcp-config JSON. */
  mcpConfigPath: string;
  /** The first `system_init` event from Maestro's stream. */
  systemInit: { sessionId: string };
}

export type MaestroEvent =
  | { type: 'system_init'; sessionId: string; tools?: string[] }
  | { type: 'assistant_text'; text: string; model?: string }
  | { type: 'assistant_thinking'; text: string }
  | { type: 'tool_use'; callId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; content: string; isError: boolean }
  | { type: 'turn_started' }
  | { type: 'turn_completed'; isError: boolean; resultText: string }
  | { type: 'idle'; payload: HookPayload }
  | { type: 'error'; reason: string };

/**
 * Long-lived `claude -p` subprocess hosting the Maestro persona.
 *
 * Wraps `WorkerManager.spawn` directly (sibling to `WorkerLifecycle`, never
 * tracked by `WorkerRegistry`). Owns: workspace setup, prompt composition,
 * mcp-config generation, deterministic session UUID, multi-turn stdin
 * relay, typed event stream.
 *
 * Stop-hook integration ships in Phase 2C.2 — until then `turn_completed`
 * is derived from stream-json `result` events.
 */
export class MaestroProcess {
  private readonly workerManager: WorkerManager;
  private readonly home?: string;
  private readonly inMemory: boolean;
  private readonly cliEntryPath: string;
  private readonly nodeBinary: string;
  private readonly promptsDir?: string;
  private readonly emitter = new EventEmitter();
  // Audit M2: small ring of recent events so iterators attached after a
  // synchronous emission still see what they missed.
  private readonly backlog: MaestroEvent[] = [];
  private worker: Worker | undefined;
  private workspace: MaestroWorkspace | undefined;
  private session: ResolvedMaestroSession | undefined;
  private mcpConfigPath: string | undefined;
  private startedFlag = false;
  private stoppedFlag = false;
  // Audit 2C.1 m8: idempotent STOPPED_EVENT emit. Today's only emit site is
  // the pump's finally block, but future kill-path emits would double-fire
  // any external `on(STOPPED_EVENT, ...)` listener. Guard at the source.
  private stopEmitted = false;
  private streamPump: Promise<void> | undefined;
  // Audit M3: gate sendUserMessage re-entrancy. `false` means the previous
  // turn has resolved (`turn_completed` or `error`); `true` means a turn is
  // streaming and a new sendUserMessage would corrupt event ordering.
  private turnInFlight = false;

  constructor(deps: MaestroProcessDeps) {
    this.workerManager = deps.workerManager;
    if (deps.home !== undefined) this.home = deps.home;
    this.inMemory = deps.inMemory === true;
    const fallbackEntry =
      typeof process.argv[1] === 'string' && process.argv[1].length > 0
        ? process.argv[1]
        : '';
    this.cliEntryPath = deps.cliEntryPath ?? fallbackEntry;
    if (this.cliEntryPath.length === 0) {
      throw new Error(
        'MaestroProcess: cliEntryPath could not be resolved from process.argv[1] — pass it explicitly',
      );
    }
    this.nodeBinary = deps.nodeBinary ?? process.execPath;
    if (deps.promptsDir !== undefined) this.promptsDir = deps.promptsDir;
    // Audit M4: lift the listener cap. Phase 3 TUI panels + awaitSystemInit
    // + scenario tests routinely cross the default-10 cap; MaestroProcess
    // is a singleton per Symphony boot — fan-out is the design.
    this.emitter.setMaxListeners(0);
  }

  /**
   * Compose the prompt + mcp-config, write them to Maestro's workspace, then
   * spawn `claude -p` with the right session/MCP wiring. Resolves once the
   * `system_init` event arrives (proves the process is up and the MCP server
   * was found).
   */
  async start(input: MaestroStartInput): Promise<MaestroStartResult> {
    if (this.startedFlag) {
      throw new Error('MaestroProcess.start() called twice on the same instance');
    }
    this.startedFlag = true;

    const workspace = await ensureMaestroWorkspace(
      this.home !== undefined ? { home: this.home } : {},
    );
    this.workspace = workspace;

    const promptBody = composeMaestroPrompt(
      input.promptVars,
      this.promptsDir !== undefined ? { promptsDir: this.promptsDir } : {},
    );
    await writeMaestroClaudeMd(workspace.claudeMdPath, MAESTRO_CLAUDE_MD_HEADER + promptBody);

    const mcpConfig = await writeMaestroMcpConfig({
      cwd: workspace.cwd,
      cliEntryPath: this.cliEntryPath,
      nodeBinary: this.nodeBinary,
      ...(this.inMemory ? { inMemory: true as const } : {}),
    });
    this.mcpConfigPath = mcpConfig.path;

    const session = resolveMaestroSession({
      cwd: workspace.cwd,
      ...(this.home !== undefined ? { home: this.home } : {}),
    });
    this.session = session;

    const extraEnv: Record<string, string> = { ...(input.extraEnv ?? {}) };
    const allowExtraEnvKeys: string[] = HOOK_ENV_KEYS.filter((k) => k in extraEnv);

    const worker = await this.workerManager.spawn({
      id: MAESTRO_WORKER_ID,
      cwd: workspace.cwd,
      // Ignored due to skipInitialPrompt — kept non-empty so a future bug
      // that bypasses the flag fails loudly with a recognizable string.
      prompt: '<MAESTRO_NO_INITIAL_PROMPT>',
      mcpConfigPath: mcpConfig.path,
      sessionId: session.sessionId,
      // Audit C1: thread the same sentinel input through the deterministic
      // UUID derivation so the warn-and-fresh fallback uses the SAME UUID
      // as the resume path. Without this, fresh boots compute a different
      // UUID than `MAESTRO_SESSION_UUID`, breaking session continuity
      // forever (the next boot wouldn't find the just-written jsonl).
      deterministicUuidInput: MAESTRO_SESSION_SENTINEL,
      onStaleResume: 'warn-and-fresh',
      keepStdinOpen: true,
      skipInitialPrompt: true,
      disableTimeout: true,
      ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
      ...(allowExtraEnvKeys.length > 0 ? { allowExtraEnvKeys } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    this.worker = worker;

    // Drain Maestro's stream into our typed event emitter.
    this.streamPump = this.pumpEvents(worker);

    // Audit M1: if `awaitSystemInit` rejects (parse_error mid-stream, child
    // exited before init), the live worker would orphan because the caller
    // never sees a handle. Kill it eagerly and rethrow.
    try {
      const systemInit = await this.awaitSystemInit();
      return { workspace, session, mcpConfigPath: mcpConfig.path, systemInit };
    } catch (err) {
      try {
        worker.kill('SIGKILL');
      } catch {
        // already dead
      }
      this.stoppedFlag = true;
      // Drain the pump promise so its error doesn't surface as unhandled.
      void this.streamPump?.catch(() => undefined);
      // Audit 2C.1 m4: best-effort delete of the regen-on-every-boot
      // workspace files we just wrote. Leaving a CLAUDE.md + mcp-config
      // pointing at a Maestro that failed to come up is misleading for
      // anyone debugging via the workspace dir. The workspace directory
      // itself is preserved; only the autogenerated files are cleared.
      await fsp.unlink(workspace.claudeMdPath).catch(() => {});
      await fsp.unlink(mcpConfig.path).catch(() => {});
      throw err;
    }
  }

  /**
   * Send a user turn into Maestro's stdin (stream-json wrap is in
   * `Worker.sendFollowup`). Throws if `start()` hasn't completed.
   *
   * NOT re-entrant — calling while a previous turn is still streaming
   * throws `MaestroTurnInFlightError` (audit M3). Wait for the
   * `turn_completed` event before queuing the next message.
   */
  sendUserMessage(text: string): void {
    if (this.worker === undefined) {
      throw new Error('MaestroProcess.sendUserMessage() called before start()');
    }
    if (this.stoppedFlag) {
      throw new Error('MaestroProcess.sendUserMessage() called after kill()');
    }
    if (this.turnInFlight) {
      throw new MaestroTurnInFlightError();
    }
    this.turnInFlight = true;
    this.emit({ type: 'turn_started' });
    this.worker.sendFollowup(text);
  }

  /**
   * Subscribe to Maestro's typed event stream. Multiple subscribers OK —
   * `EventEmitter` fans out internally, distinct from the underlying
   * `Worker.events` AsyncIterable (which is single-consumer).
   */
  on<E extends MaestroEvent['type']>(
    type: E,
    listener: (event: Extract<MaestroEvent, { type: E }>) => void,
  ): this {
    this.emitter.on(type, listener as (event: MaestroEvent) => void);
    return this;
  }

  off<E extends MaestroEvent['type']>(
    type: E,
    listener: (event: Extract<MaestroEvent, { type: E }>) => void,
  ): this {
    this.emitter.off(type, listener as (event: MaestroEvent) => void);
    return this;
  }

  /**
   * Iterate every event Maestro emits. Each call returns its own iterator
   * with its own queue + waiter — concurrent iterators ARE supported (audit
   * 2C.1 m3 doc fix). Distinct from `Worker.events`, which is single-consumer
   * by design at the stream layer; this `EventEmitter`-backed fan-out is the
   * design for Phase 3 panels.
   *
   * Includes a small pre-subscribe backlog (audit M2): if events fired
   * synchronously between `start()` resolving and the iterator's handler
   * registering, they're replayed from the ring buffer so consumers don't
   * silently drop `turn_started` etc.
   */
  async *events(): AsyncIterable<MaestroEvent> {
    const queue: MaestroEvent[] = [...this.backlog];
    const waiters: Array<(event: MaestroEvent | undefined) => void> = [];
    let stopped = false;
    const handler = (event: MaestroEvent): void => {
      if (waiters.length > 0) {
        const w = waiters.shift()!;
        w(event);
      } else {
        queue.push(event);
      }
    };
    const onStop = (): void => {
      stopped = true;
      while (waiters.length > 0) {
        const w = waiters.shift()!;
        w(undefined);
      }
    };
    this.emitter.on(ANY_EVENT, handler as (e: MaestroEvent) => void);
    this.emitter.once(STOPPED_EVENT, onStop);
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (stopped) return;
        const next = await new Promise<MaestroEvent | undefined>((resolve) =>
          waiters.push(resolve),
        );
        if (next === undefined) return;
        yield next;
      }
    } finally {
      this.emitter.off(ANY_EVENT, handler as (e: MaestroEvent) => void);
      this.emitter.off(STOPPED_EVENT, onStop);
    }
  }

  /**
   * Surface a Stop-hook fire as an `idle` event on the same emitter +
   * backlog ring used by stream-derived events. The launcher (`runStart`)
   * subscribes `MaestroHookServer.on('stop', ...)` and forwards the payload
   * through this entry point so concurrent `events()` iterators all see it
   * uniformly. No-op after `kill()`.
   */
  injectIdle(payload: HookPayload): void {
    if (this.stoppedFlag) return;
    this.emit({ type: 'idle', payload });
  }

  /** Graceful shutdown. Idempotent. */
  async kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<WorkerExitInfo | undefined> {
    if (this.stoppedFlag) return undefined;
    this.stoppedFlag = true;
    if (this.worker === undefined) return undefined;
    this.worker.kill(signal);
    const exit = await this.worker.waitForExit().catch(() => undefined);
    // m1: drain the stream-pump promise before returning so any trailing
    // `error` event fires inside the iteration, not in caller-land.
    await this.streamPump?.catch(() => undefined);
    return exit;
  }

  get currentSessionId(): string | undefined {
    return this.session?.sessionId;
  }

  get mcpConfigFile(): string | undefined {
    return this.mcpConfigPath;
  }

  get cwd(): string | undefined {
    return this.workspace?.cwd;
  }

  // ── internals ──────────────────────────────────────────────────────

  private async pumpEvents(worker: Worker): Promise<void> {
    try {
      for await (const event of worker.events) {
        const mapped = mapStreamEvent(event);
        if (mapped === null) continue;
        if (mapped.type === 'turn_completed' || mapped.type === 'error') {
          // M3: the next user message is allowed once the turn resolves.
          this.turnInFlight = false;
        }
        this.emit(mapped);
      }
    } catch (err) {
      this.turnInFlight = false;
      this.emit({
        type: 'error',
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.emitStopped();
    }
  }

  private emitStopped(): void {
    if (this.stopEmitted) return;
    this.stopEmitted = true;
    this.emitter.emit(STOPPED_EVENT);
  }

  private emit(event: MaestroEvent): void {
    // M2: small ring of recent events for late iterators.
    this.backlog.push(event);
    if (this.backlog.length > EVENTS_BACKLOG_CAP) {
      this.backlog.splice(0, this.backlog.length - EVENTS_BACKLOG_CAP);
    }
    this.emitter.emit(event.type, event);
    this.emitter.emit(ANY_EVENT, event);
  }

  private async awaitSystemInit(): Promise<{ sessionId: string }> {
    return new Promise<{ sessionId: string }>((resolve, reject) => {
      const onInit = (event: MaestroEvent): void => {
        if (event.type !== 'system_init') return;
        cleanup();
        resolve({ sessionId: event.sessionId });
      };
      const onError = (event: MaestroEvent): void => {
        if (event.type !== 'error') return;
        cleanup();
        reject(new Error(`Maestro stream error before system_init: ${event.reason}`));
      };
      const onStop = (): void => {
        cleanup();
        reject(new Error('Maestro process exited before emitting system_init'));
      };
      const cleanup = (): void => {
        this.emitter.off(ANY_EVENT, onInit as (e: MaestroEvent) => void);
        this.emitter.off(ANY_EVENT, onError as (e: MaestroEvent) => void);
        this.emitter.off(STOPPED_EVENT, onStop);
      };
      this.emitter.on(ANY_EVENT, onInit as (e: MaestroEvent) => void);
      this.emitter.on(ANY_EVENT, onError as (e: MaestroEvent) => void);
      this.emitter.once(STOPPED_EVENT, onStop);
    });
  }
}

function mapStreamEvent(event: StreamEvent): MaestroEvent | null {
  switch (event.type) {
    case 'system_init':
      return {
        type: 'system_init',
        sessionId: event.sessionId,
        ...(event.tools !== undefined ? { tools: event.tools } : {}),
      };
    case 'assistant_text':
      return {
        type: 'assistant_text',
        text: event.text,
        ...(event.model !== undefined ? { model: event.model } : {}),
      };
    case 'assistant_thinking':
      return { type: 'assistant_thinking', text: event.text };
    case 'tool_use':
      return {
        type: 'tool_use',
        callId: event.callId,
        name: event.name,
        input: event.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        callId: event.callId,
        content: event.content,
        isError: event.isError,
      };
    case 'result':
      return {
        type: 'turn_completed',
        isError: event.isError,
        resultText: event.resultText,
      };
    case 'parse_error':
      return { type: 'error', reason: `parse_error: ${event.reason}` };
    case 'system':
    case 'system_api_retry':
    case 'control_request':
    case 'log':
    case 'structured_completion':
      // Silent for Maestro consumers (control_request is auto-ack'd by
      // WorkerManager). Surface later if a TUI use case demands it.
      return null;
    default: {
      // Defensive — never let an unhandled event silently disappear.
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

