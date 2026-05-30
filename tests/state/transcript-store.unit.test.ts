/**
 * Phase 6D.1 — TranscriptStore unit tests.
 *
 * Parametrized across the in-memory oracle and SqliteTranscriptStore so
 * the two stay behaviorally identical (audit-M4 parity rationale). All
 * timing is deterministic: timestamps are epoch-anchored (so compaction
 * buckets are predictable) and `now` is injected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteTranscriptStore } from '../../src/state/sqlite-transcript-store.js';
import {
  buildContext,
  capSummaryText,
  createMemoryTranscriptStore,
  groupAgedChunks,
  heuristicSummarize,
  heuristicSummarizer,
  type CompactionConfig,
  type Summarizer,
  type TranscriptChunk,
  type TranscriptStore,
} from '../../src/state/transcript-store.js';

/** ISO timestamp at `ms` past the Unix epoch (bucket-predictable). */
const tsAt = (ms: number): string => new Date(ms).toISOString();

const HUGE = 1_000_000_000_000; // ~ year 33658, far past any test ts

function baseConfig(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
  return {
    rawRetentionMs: 0,
    summaryRetentionMs: HUGE,
    maxChunks: 100_000,
    windowMs: 15 * 60 * 1000,
    summaryMaxChars: 500,
    ...overrides,
  };
}

interface Harness {
  store: TranscriptStore;
  teardown(): void;
}

const backends: ReadonlyArray<[string, () => Harness]> = [
  [
    'memory',
    () => ({ store: createMemoryTranscriptStore(), teardown: () => undefined }),
  ],
  [
    'sqlite',
    () => {
      const db = SymphonyDatabase.open({ filePath: ':memory:' });
      return { store: new SqliteTranscriptStore(db.db), teardown: () => db.close() };
    },
  ],
];

describe.each(backends)('TranscriptStore [%s]', (_name, make) => {
  let h: Harness;
  let store: TranscriptStore;

  beforeEach(() => {
    h = make();
    store = h.store;
  });
  afterEach(() => h.teardown());

  it('append inserts a raw chunk with defaults', () => {
    const c = store.append({ sessionId: 's1', ts: tsAt(1000), tMs: 1000, text: 'hello' });
    expect(c.id).toBeGreaterThan(0);
    expect(c.kind).toBe('raw');
    expect(c.source).toBe('vad');
    expect(c.rawCount).toBe(0);
    expect(c.spanStartTs).toBeNull();
    expect(c.createdAt).toBe(tsAt(1000)); // defaults to ts
    expect(store.count()).toBe(1);
  });

  it('append honors an explicit wake source', () => {
    const c = store.append({ sessionId: 's1', ts: tsAt(1), tMs: 1, text: 'hi', source: 'wake' });
    expect(c.source).toBe('wake');
  });

  it('list orders newest-first by default and respects asc', () => {
    store.append({ sessionId: 's1', ts: tsAt(1000), tMs: 1, text: 'a' });
    store.append({ sessionId: 's1', ts: tsAt(2000), tMs: 2, text: 'b' });
    store.append({ sessionId: 's1', ts: tsAt(3000), tMs: 3, text: 'c' });
    expect(store.list().map((c) => c.text)).toEqual(['c', 'b', 'a']);
    expect(store.list({ order: 'asc' }).map((c) => c.text)).toEqual(['a', 'b', 'c']);
  });

  it('list filters by session, kind, and ts bounds', () => {
    store.append({ sessionId: 's1', ts: tsAt(1000), tMs: 1, text: 'a' });
    store.append({ sessionId: 's2', ts: tsAt(2000), tMs: 2, text: 'b' });
    store.append({ sessionId: 's1', ts: tsAt(3000), tMs: 3, text: 'c' });
    expect(store.list({ sessionId: 's1' }).map((c) => c.text).sort()).toEqual(['a', 'c']);
    expect(store.list({ kinds: ['summary'] })).toEqual([]);
    expect(store.list({ sinceTs: tsAt(2000), untilTs: tsAt(2000) }).map((c) => c.text)).toEqual(['b']);
  });

  it('list clamps limit + applies offset', () => {
    for (let i = 0; i < 10; i += 1) {
      store.append({ sessionId: 's1', ts: tsAt(1000 + i), tMs: i, text: `t${i}` });
    }
    expect(store.list({ limit: 3, order: 'asc' }).map((c) => c.text)).toEqual(['t0', 't1', 't2']);
    expect(store.list({ limit: 3, offset: 3, order: 'asc' }).map((c) => c.text)).toEqual([
      't3',
      't4',
      't5',
    ]);
    expect(store.list({ limit: 0 }).length).toBeGreaterThan(0); // 0 → default, not empty
  });

  it('getContext returns chronological text capped by maxChars (front-trim)', () => {
    store.append({ sessionId: 's1', ts: tsAt(1000), tMs: 1, text: 'aaaa' });
    store.append({ sessionId: 's1', ts: tsAt(2000), tMs: 2, text: 'bbbb' });
    store.append({ sessionId: 's1', ts: tsAt(3000), tMs: 3, text: 'cccc' });
    const ctx = store.getContext({ sessionId: 's1', maxChars: 9 });
    // 'bbbb\ncccc' = 9 chars; 'aaaa' dropped (oldest first).
    expect(ctx.text).toBe('bbbb\ncccc');
    expect(ctx.truncated).toBe(true);
    expect(ctx.rawCount).toBe(2);
  });

  it('getContext lastN keeps the most recent N chunks', () => {
    for (let i = 0; i < 5; i += 1) {
      store.append({ sessionId: 's1', ts: tsAt(1000 + i * 1000), tMs: i, text: `t${i}` });
    }
    const ctx = store.getContext({ sessionId: 's1', lastN: 2 });
    expect(ctx.text).toBe('t3\nt4');
    expect(ctx.chunkCount).toBe(2);
  });

  it('getContext sinceMs filters by wall-clock window', () => {
    const now = 10_000;
    store.append({ sessionId: 's1', ts: tsAt(1000), tMs: 1, text: 'old' });
    store.append({ sessionId: 's1', ts: tsAt(9000), tMs: 2, text: 'recent' });
    const ctx = store.getContext({ sessionId: 's1', sinceMs: 5000, now });
    expect(ctx.text).toBe('recent');
  });

  it('compact rolls aged raw chunks in one window into a single summary', async () => {
    store.append({ sessionId: 's1', ts: tsAt(0), tMs: 0, text: 'refactor auth' });
    store.append({ sessionId: 's1', ts: tsAt(60_000), tMs: 60_000, text: 'update login' });
    store.append({ sessionId: 's1', ts: tsAt(120_000), tMs: 120_000, text: 'run tests' });
    const res = await store.compact(HUGE, heuristicSummarizer, baseConfig({ rawRetentionMs: 1000 }));
    expect(res.summariesCreated).toBe(1);
    expect(res.rawChunksRolledUp).toBe(3);
    expect(store.list({ kinds: ['raw'] })).toEqual([]);
    const summaries = store.list({ kinds: ['summary'] });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.rawCount).toBe(3);
    expect(summaries[0]!.text).toBe('refactor auth update login run tests');
    expect(summaries[0]!.spanStartTs).toBe(tsAt(0));
    expect(summaries[0]!.spanEndTs).toBe(tsAt(120_000));
  });

  it('compact creates one summary per time bucket', async () => {
    store.append({ sessionId: 's1', ts: tsAt(0), tMs: 0, text: 'win one a' });
    store.append({ sessionId: 's1', ts: tsAt(60_000), tMs: 60_000, text: 'win one b' });
    // 1_000_000ms / 900_000 = bucket 1 (distinct from bucket 0)
    store.append({ sessionId: 's1', ts: tsAt(1_000_000), tMs: 1_000_000, text: 'win two' });
    const res = await store.compact(HUGE, heuristicSummarizer, baseConfig({ rawRetentionMs: 1000 }));
    expect(res.summariesCreated).toBe(2);
    expect(store.list({ kinds: ['summary'] })).toHaveLength(2);
  });

  it('compact does not summarize chunks newer than the retention window', async () => {
    const now = 1_000_000;
    store.append({ sessionId: 's1', ts: tsAt(now - 1000), tMs: 1, text: 'recent' });
    const res = await store.compact(now, heuristicSummarizer, baseConfig({ rawRetentionMs: 60_000 }));
    expect(res.summariesCreated).toBe(0);
    expect(store.list({ kinds: ['raw'] })).toHaveLength(1);
  });

  it('compact prunes summaries older than summaryRetentionMs', async () => {
    store.append({ sessionId: 's1', ts: tsAt(0), tMs: 0, text: 'a' });
    // Pass 1: create the summary, keep it (huge summary retention).
    await store.compact(HUGE, heuristicSummarizer, baseConfig({ rawRetentionMs: 1000 }));
    expect(store.list({ kinds: ['summary'] })).toHaveLength(1);
    // Pass 2 (later, tiny summary retention): the 1970-era summary is aged out.
    const res = await store.compact(HUGE, heuristicSummarizer, baseConfig({ summaryRetentionMs: 1000 }));
    expect(res.summariesPruned).toBe(1);
    expect(store.list({ kinds: ['summary'] })).toEqual([]);
  });

  it('compact evicts oldest rows past maxChunks', async () => {
    for (let i = 0; i < 5; i += 1) {
      store.append({ sessionId: 's1', ts: tsAt(1000 + i), tMs: i, text: `t${i}` });
    }
    // rawRetentionMs huge → no rollup; ceiling forces eviction of the 2 oldest.
    const res = await store.compact(
      HUGE,
      heuristicSummarizer,
      baseConfig({ rawRetentionMs: HUGE, maxChunks: 3 }),
    );
    expect(res.chunksEvicted).toBe(2);
    expect(store.list({ order: 'asc' }).map((c) => c.text)).toEqual(['t2', 't3', 't4']);
  });

  it('compact deletes covered rows by id — chunks appended during the await survive', async () => {
    store.append({ sessionId: 's1', ts: tsAt(0), tMs: 0, text: 'aged' });
    // A summarizer that appends a fresh (non-aged) chunk mid-flight.
    const racingSummarizer: Summarizer = async (texts) => {
      store.append({ sessionId: 's1', ts: tsAt(HUGE), tMs: 1, text: 'live append' });
      return heuristicSummarize(texts);
    };
    const res = await store.compact(HUGE, racingSummarizer, baseConfig({ rawRetentionMs: 1000 }));
    expect(res.rawChunksRolledUp).toBe(1);
    const raws = store.list({ kinds: ['raw'] });
    expect(raws.map((c) => c.text)).toEqual(['live append']);
  });

  it('compact applies the summaryMaxChars cap', async () => {
    store.append({ sessionId: 's1', ts: tsAt(0), tMs: 0, text: 'x'.repeat(50) });
    store.append({ sessionId: 's1', ts: tsAt(1000), tMs: 1, text: 'y'.repeat(50) });
    await store.compact(HUGE, heuristicSummarizer, baseConfig({ rawRetentionMs: 1000, summaryMaxChars: 20 }));
    const summary = store.list({ kinds: ['summary'] })[0]!;
    expect(summary.text.length).toBeLessThanOrEqual(20);
    expect(summary.text.endsWith('…')).toBe(true);
  });

  it('getContext interleaves summaries before newer raw chunks chronologically', async () => {
    store.append({ sessionId: 's1', ts: tsAt(0), tMs: 0, text: 'old one' });
    store.append({ sessionId: 's1', ts: tsAt(1000), tMs: 1, text: 'old two' });
    await store.compact(HUGE, heuristicSummarizer, baseConfig({ rawRetentionMs: 1000 }));
    // A fresh raw chunk well after the summarized span.
    store.append({ sessionId: 's1', ts: tsAt(HUGE), tMs: 2, text: 'fresh' });
    const ctx = store.getContext({ sessionId: 's1', maxChars: 1000 });
    expect(ctx.summaryCount).toBe(1);
    expect(ctx.rawCount).toBe(1);
    // Summary (span end @ ts 1000) sorts before the fresh raw (ts HUGE).
    expect(ctx.text).toBe('old one old two\nfresh');
  });

  it('getContext returns the MOST-RECENT rows when the buffer exceeds the scan cap (audit-C1)', () => {
    const N = 1100; // > TRANSCRIPT_CONTEXT_QUERY_LIMIT (1000)
    for (let i = 0; i < N; i += 1) {
      store.append({ sessionId: 's1', ts: tsAt(1_000_000 + i * 1000), tMs: i, text: `chunk-${i}` });
    }
    // lastN must surface the NEWEST 3, never the oldest 3.
    expect(store.getContext({ sessionId: 's1', lastN: 3 }).text).toBe(
      'chunk-1097\nchunk-1098\nchunk-1099',
    );
    // Default maxChars: newest present, oldest unreachable, last line is newest.
    const def = store.getContext({ sessionId: 's1' });
    const lines = def.text.split('\n');
    expect(def.text).toContain('chunk-1099');
    expect(Number(lines[lines.length - 1]!.replace('chunk-', ''))).toBe(1099);
    expect(Number(lines[0]!.replace('chunk-', ''))).toBeGreaterThan(900);
  });

  it('clearSession deletes only that session', () => {
    store.append({ sessionId: 's1', ts: tsAt(1), tMs: 1, text: 'a' });
    store.append({ sessionId: 's2', ts: tsAt(2), tMs: 2, text: 'b' });
    expect(store.clearSession('s1')).toBe(1);
    expect(store.list().map((c) => c.text)).toEqual(['b']);
  });
});

describe('pure helpers', () => {
  it('heuristicSummarize joins, collapses whitespace, drops adjacent dupes', () => {
    expect(heuristicSummarize(['  hello   world ', 'hello world', 'next thing'])).toBe(
      'hello world next thing',
    );
    expect(heuristicSummarize(['', '   ', 'only'])).toBe('only');
    expect(heuristicSummarize([])).toBe('');
  });

  it('capSummaryText truncates with an ellipsis only when over budget', () => {
    expect(capSummaryText('short', 100)).toBe('short');
    expect(capSummaryText('abcdef', 4)).toBe('abc…');
    expect(capSummaryText('anything', 0)).toBe('');
  });

  it('groupAgedChunks buckets per session + time window in first-seen order', () => {
    const groups = groupAgedChunks(
      [
        { sessionId: 's1', ts: tsAt(0) },
        { sessionId: 's1', ts: tsAt(60_000) },
        { sessionId: 's2', ts: tsAt(0) },
        { sessionId: 's1', ts: tsAt(1_000_000) },
      ],
      900_000,
    );
    expect(groups).toHaveLength(3); // s1/bucket0, s2/bucket0, s1/bucket1
    expect(groups[0]).toHaveLength(2);
  });

  it('buildContext counts kinds and reports truncation', () => {
    const chunks: TranscriptChunk[] = [
      mkChunk('summary', 'sum', tsAt(0)),
      mkChunk('raw', 'raw one', tsAt(1000)),
    ];
    const ctx = buildContext(chunks, { maxChars: 1000 });
    expect(ctx.summaryCount).toBe(1);
    expect(ctx.rawCount).toBe(1);
    expect(ctx.truncated).toBe(false);
    expect(ctx.text).toBe('sum\nraw one');
  });
});

function mkChunk(kind: 'raw' | 'summary', text: string, ts: string): TranscriptChunk {
  return {
    id: 1,
    sessionId: 's1',
    kind,
    ts,
    tMs: 0,
    text,
    source: kind === 'summary' ? 'summary' : 'vad',
    spanStartTs: null,
    spanEndTs: null,
    rawCount: 0,
    createdAt: ts,
  };
}
