import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  buildHeuristicSummary,
  buildSummaryPrompt,
  coerceParsedSummary,
  createCompletionSummarizer,
  formatDuration,
} from '../../src/orchestrator/completion-summarizer.js';
import { WorkerCompletionsBroker } from '../../src/orchestrator/completions-broker.js';
import type {
  CompletionSummarizerHandle,
  CompletionSummary,
  OneShotInvoker,
} from '../../src/orchestrator/completion-summarizer-types.js';
import type { WorkerRecord } from '../../src/orchestrator/worker-registry.js';
import type { StreamEvent, WorkerExitInfo } from '../../src/workers/types.js';

/**
 * Phase 3K — completion summarizer policy engine tests.
 *
 * The summarizer is decoupled from the platform — these tests inject a
 * fake `oneShot` runner returning canned JSON / errors and assert on
 * what would have been published to the broker. No real `claude -p` is
 * spawned.
 *
 * Async-shape note: `onWorkerExit` is sync-fire-and-forget from the
 * lifecycle's perspective, but internally `await oneShot()` and parse.
 * Tests use `flushPending` to drain microtasks before assertion.
 */

interface Harness {
  summarizer: CompletionSummarizerHandle;
  broker: WorkerCompletionsBroker;
  published: CompletionSummary[];
  oneShot: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  flushPending(): Promise<void>;
}

function makeHarness(opts: {
  oneShotImpl?: OneShotInvoker;
  oneShotImplFactory?: () => OneShotInvoker;
} = {}): Harness {
  const broker = new WorkerCompletionsBroker();
  const published: CompletionSummary[] = [];
  broker.subscribe((s) => {
    published.push(s);
  });
  const onError = vi.fn();
  const defaultOneShot: OneShotInvoker = async () => ({
    text: JSON.stringify({ headline: 'default headline' }),
    exitCode: 0,
  });
  const impl = opts.oneShotImplFactory?.() ?? opts.oneShotImpl ?? defaultOneShot;
  const oneShotFn = vi.fn().mockImplementation(impl);
  const summarizer = createCompletionSummarizer({
    broker,
    oneShot: oneShotFn as unknown as OneShotInvoker,
    getWorkerName: (r) => `Worker-${r.id.slice(0, 6)}`,
    getProjectName: (r) => r.projectPath.split(/[/\\]/).pop() ?? 'proj',
    now: () => 1_700_000_000_000,
    onError,
  });
  return {
    summarizer,
    broker,
    published,
    oneShot: oneShotFn,
    onError,
    flushPending: async () => {
      for (let i = 0; i < 16; i += 1) {

        await Promise.resolve();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function makeRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  const events: StreamEvent[] = [];
  const buffer = {
    tail: (_n: number): StreamEvent[] => events.slice(),
    push: (e: StreamEvent): void => {
      events.push(e);
    },
    size: () => events.length,
    total: () => events.length,
    clear: () => {
      events.length = 0;
    },
    capacity: 2000,
  };
  return {
    id: 'wk-test',
    projectPath: '/proj/mathscrabble',
    projectId: 'proj-1',
    taskId: null,
    worktreePath: '/proj/mathscrabble/.symphony/worktrees/wk-test',
    role: 'implementer',
    featureIntent: 'wire friend system endpoints',
    taskDescription: 'Friend system',
    autonomyTier: 1 as const,
    dependsOn: [],
    createdAt: new Date(0).toISOString(),
    status: 'completed',
    exitInfo: {
      status: 'completed',
      exitCode: 0,
      signal: null,
      durationMs: 138_000, // 2m 18s
    } as WorkerExitInfo,
    buffer: buffer as never,
    worker: {} as never,
    detach: () => {},
    ...overrides,
  } as WorkerRecord;
}

function pushEvents(record: WorkerRecord, events: StreamEvent[]): void {
  for (const e of events) {
    (record.buffer as unknown as { push(e: StreamEvent): void }).push(e);
  }
}

// ── Helper-fn coverage ───────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats sub-minute as Ns', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(59_999)).toBe('59s');
  });

  it('formats minutes with optional seconds', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(138_000)).toBe('2m 18s');
    expect(formatDuration(3_540_000)).toBe('59m');
  });

  it('formats hours with optional minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(7_440_000)).toBe('2h 4m');
  });

  it('returns "(unknown)" on non-finite or negative input', () => {
    expect(formatDuration(NaN)).toBe('(unknown)');
    expect(formatDuration(-1)).toBe('(unknown)');
    expect(formatDuration(Infinity)).toBe('(unknown)');
  });
});

describe('coerceParsedSummary', () => {
  it('returns null on non-object input', () => {
    expect(coerceParsedSummary(null)).toBeNull();
    expect(coerceParsedSummary('string')).toBeNull();
    expect(coerceParsedSummary(42)).toBeNull();
  });

  it('returns null when headline is missing or empty', () => {
    expect(coerceParsedSummary({})).toBeNull();
    expect(coerceParsedSummary({ headline: '' })).toBeNull();
    expect(coerceParsedSummary({ headline: '   ' })).toBeNull();
    expect(coerceParsedSummary({ headline: null })).toBeNull();
  });

  it('extracts headline + optional metrics + optional details', () => {
    expect(
      coerceParsedSummary({ headline: 'h1', metrics: 'm1', details: 'd1' }),
    ).toEqual({ headline: 'h1', metrics: 'm1', details: 'd1' });
  });

  it('omits metrics/details when missing or empty', () => {
    expect(coerceParsedSummary({ headline: 'h1' })).toEqual({ headline: 'h1' });
    expect(coerceParsedSummary({ headline: 'h1', metrics: '' })).toEqual({
      headline: 'h1',
    });
    expect(coerceParsedSummary({ headline: 'h1', details: '   ' })).toEqual({
      headline: 'h1',
    });
  });

  it('truncates over-long headline / metrics / details with ellipsis', () => {
    const longHeadline = 'h'.repeat(500);
    const out = coerceParsedSummary({ headline: longHeadline });
    expect(out?.headline.endsWith('…')).toBe(true);
    expect(out?.headline.length).toBeLessThanOrEqual(200);
  });

  it('trims whitespace around extracted fields', () => {
    expect(
      coerceParsedSummary({ headline: '  hello  ', metrics: ' world ' }),
    ).toEqual({ headline: 'hello', metrics: 'world' });
  });
});

describe('buildSummaryPrompt', () => {
  it('includes worker name, project, status, and duration', () => {
    const prompt = buildSummaryPrompt({
      workerName: 'Violin',
      projectName: 'MathScrabble',
      status: 'completed',
      durationMs: 138_000,
      events: [],
    });
    expect(prompt).toContain('Worker: Violin');
    expect(prompt).toContain('Project: MathScrabble');
    expect(prompt).toContain('Status: completed');
    expect(prompt).toContain('Duration: 2m 18s');
  });

  it('extracts the final assistant_text run from the buffer tail', () => {
    const prompt = buildSummaryPrompt({
      workerName: 'V',
      projectName: 'p',
      status: 'completed',
      durationMs: null,
      events: [
        { type: 'tool_use', callId: 'a', name: 'Edit', input: {} },
        { type: 'tool_result', callId: 'a', content: '', isError: false },
        { type: 'assistant_text', text: 'Wired up ' },
        { type: 'assistant_text', text: 'the friend system.' },
      ],
    });
    expect(prompt).toContain('Wired up the friend system.');
  });

  it('emits "(no final message …)" when no assistant_text events', () => {
    const prompt = buildSummaryPrompt({
      workerName: 'V',
      projectName: 'p',
      status: 'crashed',
      durationMs: null,
      events: [{ type: 'tool_use', callId: 'a', name: 'Bash', input: {} }],
    });
    expect(prompt).toContain('(no final message — worker exited before responding)');
  });

  it('summarizes tool calls top-N by frequency, alphabetical tie-break', () => {
    const prompt = buildSummaryPrompt({
      workerName: 'V',
      projectName: 'p',
      status: 'completed',
      durationMs: null,
      events: [
        { type: 'tool_use', callId: '1', name: 'Edit', input: {} },
        { type: 'tool_use', callId: '2', name: 'Edit', input: {} },
        { type: 'tool_use', callId: '3', name: 'Bash', input: {} },
        { type: 'tool_use', callId: '4', name: 'Edit', input: {} },
      ],
    });
    expect(prompt).toContain('- 3× Edit');
    expect(prompt).toContain('- 1× Bash');
    // Edit listed before Bash by frequency.
    expect(prompt.indexOf('Edit')).toBeLessThan(prompt.indexOf('Bash'));
  });

  it('emits "(none observed)" when no tool calls', () => {
    const prompt = buildSummaryPrompt({
      workerName: 'V',
      projectName: 'p',
      status: 'completed',
      durationMs: null,
      events: [{ type: 'assistant_text', text: 'done' }],
    });
    expect(prompt).toContain('Tool calls observed:\n(none observed)');
  });

  it('caps the final-message at the byte budget with an ellipsis', () => {
    // 5 KB of 'x' chars → the helper should trim and append U+2026.
    const long = 'x'.repeat(5 * 1024);
    const prompt = buildSummaryPrompt({
      workerName: 'V',
      projectName: 'p',
      status: 'completed',
      durationMs: null,
      events: [{ type: 'assistant_text', text: long }],
    });
    // The final-message line should be < 5 KB but > 3 KB and end with '…'.
    const finalSection = prompt.split('Tool calls observed:')[0] ?? '';
    expect(finalSection.includes('xxxxxx…')).toBe(true);
    expect(Buffer.byteLength(finalSection, 'utf8')).toBeLessThan(5 * 1024);
  });
});

describe('buildHeuristicSummary', () => {
  it('completed: counts file edits if any', () => {
    const out = buildHeuristicSummary({
      status: 'completed',
      durationMs: 60_000,
      events: [
        { type: 'tool_use', callId: '1', name: 'Edit', input: {} },
        { type: 'tool_use', callId: '2', name: 'Edit', input: {} },
        { type: 'tool_use', callId: '3', name: 'Write', input: {} },
        { type: 'tool_use', callId: '4', name: 'Bash', input: {} },
      ],
    });
    expect(out.headline).toContain('3 file edits');
    expect(out.headline).toContain('4 tool calls');
    expect(out.metrics).toContain('1m');
  });

  it('completed: handles "no file edits" case', () => {
    const out = buildHeuristicSummary({
      status: 'completed',
      durationMs: 5_000,
      events: [{ type: 'tool_use', callId: '1', name: 'Bash', input: {} }],
    });
    expect(out.headline).toContain('no file edits');
  });

  it('failed/crashed/timeout map to canonical phrases', () => {
    expect(buildHeuristicSummary({ status: 'failed', durationMs: null, events: [] }).headline).toContain('failure');
    expect(buildHeuristicSummary({ status: 'crashed', durationMs: null, events: [] }).headline).toContain('crashed');
    expect(buildHeuristicSummary({ status: 'timeout', durationMs: null, events: [] }).headline).toContain('timed out');
  });

  it('appends $cost to metrics when present', () => {
    const out = buildHeuristicSummary({
      status: 'completed',
      durationMs: 1_000,
      events: [],
      costUsd: 0.0042,
    });
    expect(out.metrics).toContain('$0.0042');
  });

  it('formats >=$0.01 cost with 2 decimals', () => {
    const out = buildHeuristicSummary({
      status: 'completed',
      durationMs: 1_000,
      events: [],
      costUsd: 0.42,
    });
    expect(out.metrics).toContain('$0.42');
  });

  it('omits metrics line when no duration and no cost', () => {
    const out = buildHeuristicSummary({
      status: 'completed',
      durationMs: null,
      events: [],
    });
    expect(out.metrics).toBeUndefined();
  });
});

// ── Summarizer behavior ─────────────────────────────────────────────

describe('summarizer — happy path', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('publishes a parsed summary after onWorkerExit', async () => {
    const record = makeRecord();
    pushEvents(record, [{ type: 'assistant_text', text: 'wired endpoints' }]);
    h.summarizer.onWorkerExit(record);
    await h.flushPending();
    expect(h.published).toHaveLength(1);
    const s = h.published[0]!;
    expect(s.workerId).toBe('wk-test');
    expect(s.workerName).toBe('Worker-wk-tes');
    expect(s.projectName).toBe('mathscrabble');
    expect(s.statusKind).toBe('completed');
    expect(s.headline).toBe('default headline');
    expect(s.fallback).toBe(false);
    expect(s.durationMs).toBe(138_000);
  });

  it('passes the summary prompt to the one-shot runner', async () => {
    const record = makeRecord();
    pushEvents(record, [
      { type: 'assistant_text', text: 'wired endpoints' },
      { type: 'tool_use', callId: '1', name: 'Edit', input: {} },
    ]);
    h.summarizer.onWorkerExit(record);
    await h.flushPending();
    expect(h.oneShot).toHaveBeenCalledTimes(1);
    const call = h.oneShot.mock.calls[0]?.[0] as { prompt: string; cwd: string };
    expect(call.prompt).toContain('Worker: Worker-wk-tes');
    expect(call.prompt).toContain('wired endpoints');
    expect(call.prompt).toContain('- 1× Edit');
    expect(call.cwd).toBe('/proj/mathscrabble/.symphony/worktrees/wk-test');
  });
});

describe('summarizer — status filtering', () => {
  it('skips killed workers (silent on user-initiated termination)', async () => {
    const h = makeHarness();
    h.summarizer.onWorkerExit(makeRecord({ status: 'killed' }));
    await h.flushPending();
    expect(h.published).toHaveLength(0);
    expect(h.oneShot).not.toHaveBeenCalled();
  });

  it('skips spawning/running (defensive — wireExit fires post-markCompleted)', async () => {
    const h = makeHarness();
    h.summarizer.onWorkerExit(makeRecord({ status: 'spawning' }));
    h.summarizer.onWorkerExit(makeRecord({ status: 'running' }));
    await h.flushPending();
    expect(h.published).toHaveLength(0);
  });

  it.each(['completed', 'failed', 'crashed', 'timeout'] as const)(
    'publishes for %s status',
    async (status) => {
      const h = makeHarness();
      const record = makeRecord({ status });
      h.summarizer.onWorkerExit(record);
      await h.flushPending();
      expect(h.published).toHaveLength(1);
      expect(h.published[0]?.statusKind).toBe(status);
    },
  );
});

describe('summarizer — fallback paths', () => {
  it('falls back to heuristic when one-shot throws', async () => {
    const h = makeHarness({
      oneShotImpl: async () => {
        throw new Error('boom');
      },
    });
    const record = makeRecord();
    pushEvents(record, [
      { type: 'tool_use', callId: '1', name: 'Edit', input: {} },
      { type: 'tool_use', callId: '2', name: 'Edit', input: {} },
    ]);
    h.summarizer.onWorkerExit(record);
    await h.flushPending();
    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.fallback).toBe(true);
    expect(h.published[0]?.headline).toContain('2 file edits');
    expect(h.onError).toHaveBeenCalled();
  });

  it('falls back when one-shot exits non-zero', async () => {
    const h = makeHarness({
      oneShotImpl: async () => ({ text: '', exitCode: 1 }),
    });
    h.summarizer.onWorkerExit(makeRecord());
    await h.flushPending();
    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.fallback).toBe(true);
  });

  it('falls back when one-shot returns empty text', async () => {
    const h = makeHarness({
      oneShotImpl: async () => ({ text: '', exitCode: 0 }),
    });
    h.summarizer.onWorkerExit(makeRecord());
    await h.flushPending();
    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.fallback).toBe(true);
  });

  it('falls back when parser returns null (malformed JSON)', async () => {
    const h = makeHarness({
      oneShotImpl: async () => ({ text: 'not even close to JSON', exitCode: 0 }),
    });
    h.summarizer.onWorkerExit(makeRecord());
    await h.flushPending();
    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.fallback).toBe(true);
  });

  it('falls back when JSON parses but headline is missing', async () => {
    const h = makeHarness({
      oneShotImpl: async () => ({
        text: JSON.stringify({ metrics: 'some metric' }),
        exitCode: 0,
      }),
    });
    h.summarizer.onWorkerExit(makeRecord());
    await h.flushPending();
    expect(h.published).toHaveLength(1);
    expect(h.published[0]?.fallback).toBe(true);
  });

  it('strips markdown fences in claude output (parser path)', async () => {
    const h = makeHarness({
      oneShotImpl: async () => ({
        text: '```json\n{"headline":"fenced ok"}\n```',
        exitCode: 0,
      }),
    });
    h.summarizer.onWorkerExit(makeRecord());
    await h.flushPending();
    expect(h.published[0]?.headline).toBe('fenced ok');
    expect(h.published[0]?.fallback).toBe(false);
  });

  it('unwraps {"result": "..."} envelope from --output-format json', async () => {
    const h = makeHarness({
      oneShotImpl: async () => ({
        text: JSON.stringify({ result: '{"headline":"unwrapped"}' }),
        exitCode: 0,
      }),
    });
    h.summarizer.onWorkerExit(makeRecord());
    await h.flushPending();
    expect(h.published[0]?.headline).toBe('unwrapped');
    expect(h.published[0]?.fallback).toBe(false);
  });
});

describe('summarizer — concurrency + idempotency', () => {
  it('two parallel exits produce two parallel one-shots and two summaries', async () => {
    let resolveCount = 0;
    const h = makeHarness({
      oneShotImpl: async () => {
        resolveCount += 1;
        await Promise.resolve();
        return { text: JSON.stringify({ headline: `h${resolveCount}` }), exitCode: 0 };
      },
    });
    h.summarizer.onWorkerExit(makeRecord({ id: 'wk-1' }));
    h.summarizer.onWorkerExit(makeRecord({ id: 'wk-2' }));
    await h.flushPending();
    expect(h.oneShot).toHaveBeenCalledTimes(2);
    expect(h.published.map((s) => s.workerId).sort()).toEqual(['wk-1', 'wk-2']);
  });

  it('re-entry on the same worker id during in-flight is a no-op', async () => {
    let releaseFirst!: () => void;
    const firstResolved = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const h = makeHarness({
      oneShotImpl: async () => {
        await firstResolved;
        return { text: JSON.stringify({ headline: 'h' }), exitCode: 0 };
      },
    });
    h.summarizer.onWorkerExit(makeRecord({ id: 'wk-x' }));
    h.summarizer.onWorkerExit(makeRecord({ id: 'wk-x' }));
    expect(h.oneShot).toHaveBeenCalledTimes(1);
    releaseFirst();
    await h.flushPending();
    expect(h.published).toHaveLength(1);
  });
});

describe('summarizer — disposed-flag', () => {
  it('shutdown() drains in-flight one-shots and short-circuits subsequent calls', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({
      oneShotImpl: async () => {
        await blocker;
        return { text: JSON.stringify({ headline: 'h' }), exitCode: 0 };
      },
    });
    h.summarizer.onWorkerExit(makeRecord({ id: 'wk-a' }));
    const shutdownPromise = h.summarizer.shutdown();
    // Subsequent onWorkerExit calls after disposed flag set are no-ops.
    h.summarizer.onWorkerExit(makeRecord({ id: 'wk-b' }));
    release();
    await shutdownPromise;
    await h.flushPending();
    // The shutdown short-circuit prevents the in-flight from publishing
    // (disposed === true after shutdown awaits the promise).
    expect(h.published).toHaveLength(0);
  });

  it('shutdown is idempotent', async () => {
    const h = makeHarness();
    await h.summarizer.shutdown();
    await h.summarizer.shutdown();
    h.summarizer.onWorkerExit(makeRecord());
    await h.flushPending();
    expect(h.oneShot).not.toHaveBeenCalled();
  });
});
