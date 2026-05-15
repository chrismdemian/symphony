export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface WorkerCompletionReport {
  did: string[];
  skipped: string[];
  blockers: string[];
  open_questions: string[];
  audit: 'PASS' | 'FAIL';
  cite: string[];
  tests_run: string[];
  preview_url: string | null;
  display?: unknown;
}

export type StreamEvent =
  | SystemInitEvent
  | SystemApiRetryEvent
  | SystemEvent
  | AssistantTextEvent
  | AssistantThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | ControlRequestEvent
  | ResultEvent
  | LogEvent
  | StructuredCompletionEvent
  | ParseErrorEvent;

export interface SystemInitEvent {
  type: 'system_init';
  sessionId: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  mcpServers?: Array<{ name: string; status: string }>;
}

export interface SystemApiRetryEvent {
  type: 'system_api_retry';
  attempt?: number;
  delayMs?: number;
  raw: Record<string, unknown>;
}

export interface SystemEvent {
  type: 'system';
  subtype: string;
  sessionId?: string;
  raw: Record<string, unknown>;
}

export interface AssistantTextEvent {
  type: 'assistant_text';
  text: string;
  model?: string;
}

export interface AssistantThinkingEvent {
  type: 'assistant_thinking';
  text: string;
}

export interface ToolUseEvent {
  type: 'tool_use';
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: 'tool_result';
  callId: string;
  content: string;
  isError: boolean;
}

export interface ControlRequestEvent {
  type: 'control_request';
  requestId: string;
  subtype: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ResultEvent {
  type: 'result';
  sessionId: string;
  isError: boolean;
  resultText: string;
  durationMs: number;
  numTurns: number;
  costUsd?: number;
  usageByModel: Record<string, TokenUsage>;
  // Cumulative session usage reported by the CLI at turn end.
  // Already summed across turns — do NOT combine with usageByModel values.
  sessionUsage?: TokenUsage;
}

export interface LogEvent {
  type: 'log';
  level: string;
  message: string;
}

export interface StructuredCompletionEvent {
  type: 'structured_completion';
  report: WorkerCompletionReport;
  raw: string;
}

export interface ParseErrorEvent {
  type: 'parse_error';
  reason: string;
  line?: string;
}

// ── Worker (Phase 1B) ────────────────────────────────────────────────

export type WorkerStatus =
  | 'spawning'
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'timeout'
  | 'crashed'
  | 'interrupted';

export type KillSignal = 'SIGTERM' | 'SIGKILL';

/**
 * Why a worker is being stopped. Drives `classifyExit` mapping:
 *   `kill`      → status `killed`
 *   `timeout`   → status `timeout`
 *   `interrupt` → status `interrupted`   (Phase 3T)
 *
 * Precedence (highest wins, regardless of write order):
 *   `timeout` > `kill` > `interrupt`. Set higher-priority intents to
 *   override earlier writes (e.g. `lifecycle.shutdown()` post-pivot
 *   must override an earlier interrupt stamp so the final classification
 *   reflects shutdown, not pivot).
 */
export type StopIntent = 'kill' | 'timeout' | 'interrupt';

export interface WorkerConfig {
  id: string;
  cwd: string;
  prompt: string;
  claudePath?: string;
  model?: string;
  sessionId?: string;
  deterministicUuidInput?: string;
  maxTurns?: number;
  appendSystemPrompt?: string;
  mcpConfigPath?: string;
  extraArgs?: string[];
  extraEnv?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Keep stdin open after `result` arrives so follow-up user messages can
   * continue the same `claude -p` session. Default: false (stdin closes on
   * `result`, letting claude exit cleanly). Callers who set this MUST call
   * `worker.endInput()` when finished to allow claude to exit.
   */
  keepStdinOpen?: boolean;
  /**
   * Policy when `sessionId` is set but the corresponding jsonl file is
   * missing or the cwd doesn't match:
   * - `'reject'` (default): throw from `spawn()`. Caller must decide.
   * - `'warn-and-fresh'`: fire `onStaleResume` hook, start a fresh session.
   * - `'start-fresh'`: silently start a fresh session (only for deterministic
   *   resume loops that already expect this).
   * Silent substitution breaks observability of session identity.
   */
  onStaleResume?: 'reject' | 'warn-and-fresh' | 'start-fresh';
  /**
   * Skip writing `prompt` as the first stream-json user message. The child is
   * spawned and stdout drained, but stdin sits idle until the caller sends a
   * message via `worker.sendFollowup()`. Used by Maestro: a long-lived
   * orchestrator boots silent and waits for the human's first turn rather
   * than responding to a synthetic empty prompt. `prompt` is ignored when
   * this flag is set.
   */
  skipInitialPrompt?: boolean;
  /**
   * Disable the spawn-side timeout entirely. The default 20-minute timeout
   * exists to bound runaway one-shot workers; long-lived processes (Maestro)
   * must opt out. Mutually exclusive with a positive `timeoutMs` — if both
   * are provided, `disableTimeout` wins.
   */
  disableTimeout?: boolean;
  /**
   * Allowlist of `extraEnv` keys that bypass the SYMPHONY_*-prefix blocklist.
   * Maestro needs this for `SYMPHONY_HOOK_PORT` / `SYMPHONY_HOOK_TOKEN` so
   * its Stop hook curl command can resolve them; default empty preserves
   * the existing prefix block for every other caller.
   */
  allowExtraEnvKeys?: readonly string[];
}

export interface WorkerExitInfo {
  status: WorkerStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId?: string;
  durationMs: number;
  /** Last ~8KB of stderr captured from the child, for crash diagnosis. */
  stderrTail?: string;
}

export interface Worker {
  readonly id: string;
  readonly sessionId: string | undefined;
  readonly status: WorkerStatus;
  readonly events: AsyncIterable<StreamEvent>;
  sendFollowup(text: string): void;
  /** End stdin so claude can exit. Safe to call multiple times. */
  endInput(): void;
  /**
   * Stop the worker. Phase 3T extended this to accept an optional
   * `intent` so callers can distinguish a user-initiated single kill
   * from a pivot-driven interrupt. Default `intent='kill'` matches
   * pre-3T semantics.
   *
   * Precedence is internal: a later higher-priority intent overrides an
   * earlier lower-priority one. See `StopIntent` for the ordering.
   */
  kill(signal?: KillSignal, intent?: StopIntent): void;
  waitForExit(): Promise<WorkerExitInfo>;
}
