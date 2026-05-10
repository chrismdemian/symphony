/**
 * Phase 3K — Worker completion summarizer.
 *
 * Sits on the same `WorkerLifecycle.onWorkerStatusChange` callback the
 * notification dispatcher already uses (`server.ts:357`). On each
 * non-`killed` terminal exit, builds a 6 KB-bounded prompt from the
 * worker's last assistant message + tool-call counts, fires a one-shot
 * `claude -p --output-format json`, parses the JSON result, and
 * publishes a `CompletionSummary` through the `CompletionsBroker`.
 *
 * Failure modes (one-shot timeout, non-zero exit, parse failure, empty
 * stdout) all converge on the heuristic fallback — the chat row is the
 * contract, every non-killed exit gets one. Heuristics use the same
 * payload shape so the TUI doesn't branch on source.
 *
 * Concurrency: N parallel exits → N concurrent one-shots, each tracked
 * in `inFlight` so `shutdown()` can drain. Re-entry on the same worker
 * id is a no-op (lifecycle exits fire once, but defensive).
 *
 * Disposed-flag guard mirrors the notifications dispatcher (M2 from
 * 3H.3 review): server's close path calls `summarizer.shutdown()`
 * BEFORE `workerLifecycle.shutdown()`. Workers that fail-class-exit
 * during the lifecycle's SIGTERM kill window would otherwise re-enter
 * `onWorkerExit` and spawn orphan summarizer processes. Idempotent.
 */

import type {
  CompletionsBroker,
  CompletionStatusKind,
  CompletionSummarizerDeps,
  CompletionSummarizerHandle,
  CompletionSummary,
  OneShotInvoker,
} from './completion-summarizer-types.js';
import type { WorkerRecord } from './worker-registry.js';
import type { StreamEvent, WorkerStatus } from '../workers/types.js';
import { parseStructuredResponse } from './one-shot.js';
import { formatDuration } from './completion-summarizer-format.js';

export { formatDuration };

const FINAL_MESSAGE_CAP_BYTES = 4 * 1024;
const TOOL_CALL_TOP_N = 8;
const HEADLINE_MAX_CHARS = 200;
const FIELD_MAX_CHARS = 200;
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const SUMMARY_BUFFER_TAIL = 200;

interface ParsedSummary {
  readonly headline: string;
  readonly metrics?: string;
  readonly details?: string;
}

/**
 * Build the summarizer prompt. Deterministic, tested in isolation —
 * no side effects, no I/O.
 *
 * Cost-conscious: caps the worker's final message at 4 KB and the
 * tool-call list at the top 8 most frequent. A 6 KB prompt body with
 * Haiku stays well under a cent per summary.
 */
export function buildSummaryPrompt(input: {
  readonly workerName: string;
  readonly projectName: string;
  readonly status: WorkerStatus;
  readonly durationMs: number | null;
  readonly events: readonly StreamEvent[];
}): string {
  const { workerName, projectName, status, durationMs, events } = input;
  const finalMessage = extractFinalAssistantMessage(events);
  const toolCallSummary = summarizeToolCalls(events);
  const durationLine = durationMs !== null ? formatDuration(durationMs) : '(unknown)';

  return [
    'A Symphony worker just finished. Summarize what it did in 2-3 short lines for the user.',
    '',
    `Worker: ${workerName}`,
    `Project: ${projectName}`,
    `Status: ${status}`,
    `Duration: ${durationLine}`,
    '',
    "Final assistant message (the worker's self-report):",
    finalMessage,
    '',
    'Tool calls observed:',
    toolCallSummary,
    '',
    'Respond with ONLY a JSON object — no prose, no markdown fences:',
    '{',
    `  "headline": "Concise one-line description of what was done (max 80 chars)",`,
    `  "metrics": "Optional second line: test/build results, e.g. '12 tests passing'. Omit field if not applicable.",`,
    `  "details": "Optional third line: notable caveats, e.g. 'left TODO in auth.ts:42'. Omit field if not applicable."`,
    '}',
  ].join('\n');
}

function extractFinalAssistantMessage(events: readonly StreamEvent[]): string {
  // Walk last-to-first, collect text from the most recent contiguous
  // run of `assistant_text` events (a single logical message can span
  // multiple chunks). Stop on the first non-text event before that
  // run. Bound the result to the byte cap.
  const tail: string[] = [];
  let foundAssistantText = false;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type === 'assistant_text') {
      foundAssistantText = true;
      tail.unshift(event.text);
      continue;
    }
    if (foundAssistantText) break;
  }
  if (!foundAssistantText) return '(no final message — worker exited before responding)';
  const joined = tail.join('').trim();
  if (joined.length === 0) return '(no final message — worker exited before responding)';
  if (Buffer.byteLength(joined, 'utf8') <= FINAL_MESSAGE_CAP_BYTES) return joined;
  // Trim to the byte cap on a UTF-8-safe boundary by truncating chars
  // from the end and re-checking. Cheap because we cap at 4 KB.
  let trimmed = joined;
  while (Buffer.byteLength(trimmed, 'utf8') > FINAL_MESSAGE_CAP_BYTES - 1) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}…`;
}

function summarizeToolCalls(events: readonly StreamEvent[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'tool_use') continue;
    counts.set(event.name, (counts.get(event.name) ?? 0) + 1);
  }
  if (counts.size === 0) return '(none observed)';
  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOOL_CALL_TOP_N);
  return sorted.map(([name, count]) => `- ${count}× ${name}`).join('\n');
}

/**
 * Coerce a parsed structured response into the trimmed `ParsedSummary`
 * shape. Returns null if the headline is missing or empty (caller
 * falls through to heuristic). Defensive against non-string fields the
 * model might emit.
 */
export function coerceParsedSummary(parsed: unknown): ParsedSummary | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const headline = trimToCap(obj.headline, HEADLINE_MAX_CHARS);
  if (headline === undefined) return null;
  const metrics = trimToCap(obj.metrics, FIELD_MAX_CHARS);
  const details = trimToCap(obj.details, FIELD_MAX_CHARS);
  return {
    headline,
    ...(metrics !== undefined ? { metrics } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function trimToCap(value: unknown, cap: number): string | undefined {
  // Audit m1: empty / whitespace-only field is "absent", not "present
  // and empty" — return undefined so the spread at the call site omits
  // the key entirely.
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap - 1)}…`;
}

/**
 * Heuristic fallback: builds a summary from worker metadata alone, no
 * LLM call. Triggered on every one-shot failure mode (timeout, exit
 * non-zero, empty stdout, parse returns null). Always returns a
 * `ParsedSummary` — the chat row is the contract.
 */
export function buildHeuristicSummary(input: {
  readonly status: WorkerStatus;
  readonly durationMs: number | null;
  readonly events: readonly StreamEvent[];
  readonly costUsd?: number;
}): ParsedSummary {
  const { status, durationMs, events, costUsd } = input;
  const toolCallTotal = events.reduce(
    (acc, e) => (e.type === 'tool_use' ? acc + 1 : acc),
    0,
  );
  const fileEdits = events.reduce(
    (acc, e) =>
      e.type === 'tool_use' && (e.name === 'Edit' || e.name === 'Write')
        ? acc + 1
        : acc,
    0,
  );
  const headlineParts: string[] = [];
  switch (status) {
    case 'completed':
      headlineParts.push(fileEdits > 0 ? `${fileEdits} file edit${fileEdits === 1 ? '' : 's'}` : 'no file edits');
      break;
    case 'failed':
      headlineParts.push('worker reported failure');
      break;
    case 'crashed':
      headlineParts.push('worker crashed');
      break;
    case 'timeout':
      headlineParts.push('worker timed out');
      break;
    default:
      headlineParts.push(`status: ${status}`);
  }
  if (toolCallTotal > 0) headlineParts.push(`${toolCallTotal} tool call${toolCallTotal === 1 ? '' : 's'}`);
  const headline = headlineParts.join(' · ');

  const metricsParts: string[] = [];
  if (durationMs !== null) metricsParts.push(formatDuration(durationMs));
  if (typeof costUsd === 'number' && costUsd > 0) {
    metricsParts.push(`$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`);
  }
  const metrics = metricsParts.length > 0 ? metricsParts.join(' · ') : undefined;

  return {
    headline,
    ...(metrics !== undefined ? { metrics } : {}),
  };
}

/**
 * Map a worker terminal status to a `CompletionStatusKind`. Filters
 * out non-summary statuses (`spawning`, `running`, `killed`) as
 * `null`. The factory's `onWorkerExit` short-circuits on null.
 */
function classifyStatusForSummary(status: WorkerStatus): CompletionStatusKind | null {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'crashed':
    case 'timeout':
      return status;
    case 'killed':
    case 'spawning':
    case 'running':
      return null;
    default: {
      // Type-level exhaustiveness — surfaces new statuses at compile time.
      const _exhaustive: never = status;
      void _exhaustive;
      return null;
    }
  }
}

/**
 * Construct a completion summarizer. Returns a handle the orchestrator
 * wires into the worker lifecycle's `onWorkerStatusChange` and tears
 * down via `shutdown()` BEFORE `workerLifecycle.shutdown()`.
 */
export function createCompletionSummarizer(
  deps: CompletionSummarizerDeps,
): CompletionSummarizerHandle {
  const broker: CompletionsBroker = deps.broker;
  const oneShot: OneShotInvoker = deps.oneShot;
  const now = deps.now ?? ((): number => Date.now());
  const oneShotTimeoutMs = deps.oneShotTimeoutMs ?? 60_000;
  const model = deps.model ?? DEFAULT_MODEL;
  const onError = deps.onError ?? ((): void => undefined);

  let disposed = false;
  const inFlight = new Map<string, Promise<void>>();
  const shutdownAbort = new AbortController();

  function publish(
    record: WorkerRecord,
    statusKind: CompletionStatusKind,
    parsed: ParsedSummary,
    fallback: boolean,
  ): void {
    const summary: CompletionSummary = {
      workerId: record.id,
      workerName: deps.getWorkerName(record),
      projectName: deps.getProjectName(record),
      statusKind,
      durationMs: record.exitInfo?.durationMs ?? null,
      headline: parsed.headline,
      ...(parsed.metrics !== undefined ? { metrics: parsed.metrics } : {}),
      ...(parsed.details !== undefined ? { details: parsed.details } : {}),
      ts: new Date(now()).toISOString(),
      fallback,
    };
    broker.publish(summary);
  }

  async function summarize(record: WorkerRecord, statusKind: CompletionStatusKind): Promise<void> {
    const events = record.buffer.tail(SUMMARY_BUFFER_TAIL);
    const heuristic = (): ParsedSummary =>
      buildHeuristicSummary({
        status: record.status,
        durationMs: record.exitInfo?.durationMs ?? null,
        events,
        ...(typeof record.costUsd === 'number' ? { costUsd: record.costUsd } : {}),
      });

    const prompt = buildSummaryPrompt({
      workerName: deps.getWorkerName(record),
      projectName: deps.getProjectName(record),
      status: record.status,
      durationMs: record.exitInfo?.durationMs ?? null,
      events,
    });

    let parsed: ParsedSummary | null = null;
    let fallback = false;
    try {
      const result = await oneShot({
        prompt,
        cwd: record.worktreePath,
        model,
        timeoutMs: oneShotTimeoutMs,
        signal: shutdownAbort.signal,
      });
      if (result.exitCode === 0 && result.text.length > 0) {
        const obj = parseStructuredResponse(result.text, { requiredFields: ['headline'] });
        parsed = coerceParsedSummary(obj);
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
    if (parsed === null) {
      parsed = heuristic();
      fallback = true;
    }
    if (disposed) return;
    publish(record, statusKind, parsed, fallback);
  }

  return {
    onWorkerExit(record: WorkerRecord): void {
      if (disposed) return;
      const statusKind = classifyStatusForSummary(record.status);
      if (statusKind === null) return;
      if (inFlight.has(record.id)) return;
      const promise = summarize(record, statusKind)
        .catch((err: unknown) => {
          // Truly unhandled — should never happen since `summarize`
          // catches the one-shot error and falls back. Defensive log.
          onError(err instanceof Error ? err : new Error(String(err)));
        })
        .finally(() => {
          inFlight.delete(record.id);
        });
      inFlight.set(record.id, promise);
    },

    async shutdown(): Promise<void> {
      if (disposed) return;
      disposed = true;
      shutdownAbort.abort();
      const pending = Array.from(inFlight.values());
      await Promise.allSettled(pending);
    },
  };
}
