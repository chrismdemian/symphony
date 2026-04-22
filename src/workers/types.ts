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
  | 'timeout';

export type KillSignal = 'SIGTERM' | 'SIGKILL';

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
}

export interface WorkerExitInfo {
  status: WorkerStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId?: string;
  durationMs: number;
}

export interface Worker {
  readonly id: string;
  readonly sessionId: string | undefined;
  readonly status: WorkerStatus;
  readonly events: AsyncIterable<StreamEvent>;
  sendFollowup(text: string): void;
  kill(signal?: KillSignal): void;
  waitForExit(): Promise<WorkerExitInfo>;
}
