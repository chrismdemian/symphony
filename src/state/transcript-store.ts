/**
 * Phase 6D.1 — Rolling context buffer store contract.
 *
 * The `TranscriptStore` interface lets the capture runner + tests target
 * an in-memory oracle (`createMemoryTranscriptStore`) or the
 * `SqliteTranscriptStore` (production) without divergence — the audit-store
 * (3R) pattern. Append-only from the producer's side; compaction is the
 * only mutation path, and it's a deterministic function of an injected
 * `now` + an injected `Summarizer` (so the local-LLM summarizer in 6D.2
 * drops in without touching this layer).
 *
 * Privacy invariant: this store holds TEXT only. Raw audio never reaches
 * it — the bridge discards PCM after STT. There is no BLOB column.
 */

export type TranscriptKind = 'raw' | 'summary';
export type TranscriptSource = 'vad' | 'wake' | 'summary';

export const TRANSCRIPT_KINDS: readonly TranscriptKind[] = ['raw', 'summary'];
export const TRANSCRIPT_SOURCES: readonly TranscriptSource[] = ['vad', 'wake', 'summary'];

const KIND_SET: ReadonlySet<string> = new Set<string>(TRANSCRIPT_KINDS);
const SOURCE_SET: ReadonlySet<string> = new Set<string>(TRANSCRIPT_SOURCES);

/** Input shape for `append()` — a single VAD/wake STT `final` event. */
export interface TranscriptChunkInput {
  readonly sessionId: string;
  /** ISO 8601 wall-clock timestamp. */
  readonly ts: string;
  /** Bridge monotonic "ms since ready" (6A/6B/6C wire clock). */
  readonly tMs: number;
  readonly text: string;
  /** Default `'vad'`. `'wake'` when the utterance followed a wake-word. */
  readonly source?: TranscriptSource;
  /** Override `created_at` (tests). Default = `ts`. */
  readonly createdAt?: string;
}

export interface TranscriptChunk {
  readonly id: number;
  readonly sessionId: string;
  readonly kind: TranscriptKind;
  readonly ts: string;
  readonly tMs: number;
  readonly text: string;
  readonly source: TranscriptSource;
  /** Summary rows only: ISO ts of the earliest raw row rolled up. */
  readonly spanStartTs: string | null;
  /** Summary rows only: ISO ts of the latest raw row rolled up. */
  readonly spanEndTs: string | null;
  /** Summary rows only: how many raw rows were collapsed. 0 for raw rows. */
  readonly rawCount: number;
  readonly createdAt: string;
}

export interface TranscriptListFilter {
  readonly sessionId?: string;
  readonly kinds?: readonly TranscriptKind[];
  /** Inclusive lower bound on `ts` (ISO 8601). */
  readonly sinceTs?: string;
  /** Inclusive upper bound on `ts` (ISO 8601). */
  readonly untilTs?: string;
  /** Default 200; capped at 5000. */
  readonly limit?: number;
  /** Skip the first N rows after the sort. Default 0. */
  readonly offset?: number;
  /** Sort order on `(ts, id)`. Default `'desc'` (newest first). */
  readonly order?: 'asc' | 'desc';
}

/**
 * Query for the summon-time `<voice-context>` block. Returns the most
 * recent transcript material (summaries + raw) in chronological order,
 * trimmed from the FRONT to fit `maxChars`. Never ships raw audio; this
 * is the only path ambient transcripts leave the buffer.
 */
export interface TranscriptContextQuery {
  readonly sessionId?: string;
  /** Take at most the most-recent N chunks (raw + summary). */
  readonly lastN?: number;
  /** Only chunks with `ts >= now - sinceMs`. Requires `now`. */
  readonly sinceMs?: number;
  /** Epoch ms anchor for `sinceMs`. Injected in tests; CLI passes `Date.now()`. */
  readonly now?: number;
  /** Cap on the joined block length. Default 2000. Front-trimmed when exceeded. */
  readonly maxChars?: number;
}

export interface TranscriptContext {
  /** Chronological joined block (one chunk per line), ready to prepend. */
  readonly text: string;
  readonly chunkCount: number;
  readonly summaryCount: number;
  readonly rawCount: number;
  /** True when older chunks were dropped to fit `maxChars`. */
  readonly truncated: boolean;
}

export interface CompactionConfig {
  /** Raw rows older than this (relative to `now`) are summarized. */
  readonly rawRetentionMs: number;
  /** Summary rows older than this (relative to `now`) are deleted. */
  readonly summaryRetentionMs: number;
  /** Hard ceiling on total rows (both kinds). Oldest evicted past this. */
  readonly maxChunks: number;
  /** Rollup bucket size — aged raw rows within one window become one summary. */
  readonly windowMs: number;
  /** Final cap applied to every summary's text, regardless of summarizer. */
  readonly summaryMaxChars: number;
}

export interface CompactionResult {
  readonly summariesCreated: number;
  readonly rawChunksRolledUp: number;
  readonly summariesPruned: number;
  /** Rows deleted by the `maxChunks` ceiling. */
  readonly chunksEvicted: number;
}

/**
 * Summarizer contract — async so the 6D.2 local-LLM (T5-small ONNX
 * subprocess) drops in unchanged. `compact` applies the final
 * `summaryMaxChars` cap to the returned string, so implementations don't
 * need to.
 */
export type Summarizer = (texts: readonly string[]) => Promise<string>;

export interface TranscriptStore {
  append(input: TranscriptChunkInput): TranscriptChunk;
  list(filter?: TranscriptListFilter): TranscriptChunk[];
  count(filter?: TranscriptListFilter): number;
  getContext(query?: TranscriptContextQuery): TranscriptContext;
  /**
   * Roll up aged raw rows into local summaries and enforce retention.
   * Deterministic in (`now`, store contents, `summarize`, `config`).
   */
  compact(now: number, summarize: Summarizer, config: CompactionConfig): Promise<CompactionResult>;
  /** Drop every row for one session. Returns the number deleted. */
  clearSession(sessionId: string): number;
}

export const TRANSCRIPT_LIST_DEFAULT_LIMIT = 200;
export const TRANSCRIPT_LIST_MAX_LIMIT = 5000;
export const TRANSCRIPT_CONTEXT_DEFAULT_MAX_CHARS = 2000;

/**
 * Upper bound on rows scanned for `getContext` before front-trimming —
 * shared by both stores so the most-recent-N scan is identical. The real
 * `maxChars` trim happens in `buildContext`; this just bounds the scan on
 * a pathologically large buffer to the MOST RECENT rows (audit-C1).
 */
export const TRANSCRIPT_CONTEXT_QUERY_LIMIT = 1000;

/** Default rollup bucket — internal constant, not a user knob in 6D.1. */
export const DEFAULT_COMPACTION_WINDOW_MS = 15 * 60 * 1000;

/** Shared limit clamp — keeps the in-memory oracle behaviorally identical. */
export function clampTranscriptLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return TRANSCRIPT_LIST_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(raw), TRANSCRIPT_LIST_MAX_LIMIT);
}

/** Shared offset coercion — negative / non-finite → 0, else floored. */
export function clampTranscriptOffset(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/**
 * Deterministic extractive summarizer — the always-capture default and
 * the 6D.2 fallback when the local model is unavailable. Joins utterances
 * in order, collapses internal whitespace, drops adjacent
 * case-insensitive duplicates (Moonshine re-emits near-identical partials
 * on slow speech). No external deps, no tokens — honors the "no LLM
 * traffic on ambient input" mandate. `compact` applies the length cap, so
 * this returns the full joined text.
 */
export function heuristicSummarize(texts: readonly string[]): string {
  const cleaned: string[] = [];
  for (const raw of texts) {
    const s = raw.trim().replace(/\s+/g, ' ');
    if (s.length === 0) continue;
    const prev = cleaned[cleaned.length - 1];
    if (prev !== undefined && prev.toLowerCase() === s.toLowerCase()) continue;
    cleaned.push(s);
  }
  return cleaned.join(' ');
}

/** The default `Summarizer` — wraps `heuristicSummarize` as a resolved promise. */
export const heuristicSummarizer: Summarizer = (texts) =>
  Promise.resolve(heuristicSummarize(texts));

/** Truncate `text` to `maxChars`, appending a single-char ellipsis when cut. */
export function capSummaryText(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1).trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// In-memory oracle — used by tests + as a no-DB fallback. Mirrors
// SqliteTranscriptStore semantics exactly (audit-M4 parity rationale).
// ---------------------------------------------------------------------------

interface MemoryRow {
  id: number;
  sessionId: string;
  kind: TranscriptKind;
  ts: string;
  tMs: number;
  text: string;
  source: TranscriptSource;
  spanStartTs: string | null;
  spanEndTs: string | null;
  rawCount: number;
  createdAt: string;
}

function rowToChunk(r: MemoryRow): TranscriptChunk {
  return {
    id: r.id,
    sessionId: r.sessionId,
    kind: r.kind,
    ts: r.ts,
    tMs: r.tMs,
    text: r.text,
    source: r.source,
    spanStartTs: r.spanStartTs,
    spanEndTs: r.spanEndTs,
    rawCount: r.rawCount,
    createdAt: r.createdAt,
  };
}

export function createMemoryTranscriptStore(): TranscriptStore {
  const rows: MemoryRow[] = [];
  let nextId = 1;

  const matches = (r: MemoryRow, f: TranscriptListFilter): boolean => {
    if (f.sessionId !== undefined && r.sessionId !== f.sessionId) return false;
    if (f.kinds !== undefined && f.kinds.length > 0 && !f.kinds.includes(r.kind)) return false;
    if (f.sinceTs !== undefined && r.ts < f.sinceTs) return false;
    if (f.untilTs !== undefined && r.ts > f.untilTs) return false;
    return true;
  };

  const sorted = (f: TranscriptListFilter): MemoryRow[] => {
    const matched = rows.filter((r) => matches(r, f));
    const dir = f.order === 'asc' ? 1 : -1;
    matched.sort((a, b) => {
      if (a.ts < b.ts) return -1 * dir;
      if (a.ts > b.ts) return 1 * dir;
      return (a.id - b.id) * dir;
    });
    return matched;
  };

  return {
    append(input: TranscriptChunkInput): TranscriptChunk {
      const source: TranscriptSource =
        input.source !== undefined && SOURCE_SET.has(input.source) ? input.source : 'vad';
      const row: MemoryRow = {
        id: nextId++,
        sessionId: input.sessionId,
        kind: 'raw',
        ts: input.ts,
        tMs: input.tMs,
        text: input.text,
        source,
        spanStartTs: null,
        spanEndTs: null,
        rawCount: 0,
        createdAt: input.createdAt ?? input.ts,
      };
      rows.push(row);
      return rowToChunk(row);
    },

    list(filter: TranscriptListFilter = {}): TranscriptChunk[] {
      const limit = clampTranscriptLimit(filter.limit);
      const offset = clampTranscriptOffset(filter.offset);
      return sorted(filter).slice(offset, offset + limit).map(rowToChunk);
    },

    count(filter: TranscriptListFilter = {}): number {
      return rows.filter((r) => matches(r, filter)).length;
    },

    getContext(query: TranscriptContextQuery = {}): TranscriptContext {
      // Scan the MOST-RECENT rows (parity with SqliteTranscriptStore's
      // DESC-LIMIT + reverse, audit-C1): take the tail of the ascending
      // list capped at TRANSCRIPT_CONTEXT_QUERY_LIMIT.
      const asc = sorted({
        ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
        ...(query.sinceMs !== undefined && query.now !== undefined
          ? { sinceTs: new Date(query.now - query.sinceMs).toISOString() }
          : {}),
        order: 'asc',
      }).map(rowToChunk);
      const recent =
        asc.length > TRANSCRIPT_CONTEXT_QUERY_LIMIT
          ? asc.slice(asc.length - TRANSCRIPT_CONTEXT_QUERY_LIMIT)
          : asc;
      return buildContext(recent, query);
    },

    async compact(
      now: number,
      summarize: Summarizer,
      config: CompactionConfig,
    ): Promise<CompactionResult> {
      const cutoffRaw = new Date(now - config.rawRetentionMs).toISOString();
      const aged = rows
        .filter((r) => r.kind === 'raw' && r.ts < cutoffRaw)
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id));

      // Group by session + time bucket, preserving the injected-`now`
      // determinism (bucket keyed off the row's own ts, not wall-clock).
      const groups = groupAgedChunks(aged, config.windowMs);
      const pending: Array<{
        summary: string;
        first: MemoryRow;
        last: MemoryRow;
        ids: Set<number>;
      }> = [];
      for (const group of groups) {
        const text = capSummaryText(
          await summarize(group.map((r) => r.text)),
          config.summaryMaxChars,
        );
        pending.push({
          summary: text,
          first: group[0]!,
          last: group[group.length - 1]!,
          ids: new Set(group.map((r) => r.id)),
        });
      }

      let summariesCreated = 0;
      let rawChunksRolledUp = 0;
      for (const p of pending) {
        // Delete the covered raw rows by explicit id (anything appended
        // during the await is untouched).
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (p.ids.has(rows[i]!.id)) rows.splice(i, 1);
        }
        rawChunksRolledUp += p.ids.size;
        rows.push({
          id: nextId++,
          sessionId: p.last.sessionId,
          kind: 'summary',
          ts: p.last.ts,
          tMs: p.last.tMs,
          text: p.summary,
          source: 'summary',
          spanStartTs: p.first.ts,
          spanEndTs: p.last.ts,
          rawCount: p.ids.size,
          createdAt: new Date(now).toISOString(),
        });
        summariesCreated += 1;
      }

      // Prune aged summaries.
      const cutoffSummary = new Date(now - config.summaryRetentionMs).toISOString();
      let summariesPruned = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i]!.kind === 'summary' && rows[i]!.ts < cutoffSummary) {
          rows.splice(i, 1);
          summariesPruned += 1;
        }
      }

      // Enforce the hard ceiling — evict oldest.
      let chunksEvicted = 0;
      if (rows.length > config.maxChunks) {
        const excess = rows.length - config.maxChunks;
        const byOldest = [...rows].sort((a, b) =>
          a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id - b.id,
        );
        const evictIds = new Set(byOldest.slice(0, excess).map((r) => r.id));
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (evictIds.has(rows[i]!.id)) rows.splice(i, 1);
        }
        chunksEvicted = excess;
      }

      return { summariesCreated, rawChunksRolledUp, summariesPruned, chunksEvicted };
    },

    clearSession(sessionId: string): number {
      let deleted = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i]!.sessionId === sessionId) {
          rows.splice(i, 1);
          deleted += 1;
        }
      }
      return deleted;
    },
  };
}

// ---------------------------------------------------------------------------
// Shared helpers — used by BOTH the memory oracle and SqliteTranscriptStore
// so compaction grouping + context assembly can't drift between them.
// ---------------------------------------------------------------------------

export interface AgedLike {
  readonly sessionId: string;
  readonly ts: string;
}

/**
 * Group already-ts-sorted aged rows into per-session time buckets of
 * `windowMs`. Bucket index is `floor(Date.parse(ts) / windowMs)`; a
 * non-parseable ts falls into its own singleton bucket keyed by id-less
 * sentinel so it's never merged with real spans.
 */
export function groupAgedChunks<T extends AgedLike>(aged: readonly T[], windowMs: number): T[][] {
  const order: string[] = [];
  const buckets = new Map<string, T[]>();
  const w = windowMs > 0 ? windowMs : DEFAULT_COMPACTION_WINDOW_MS;
  for (const row of aged) {
    const epoch = Date.parse(row.ts);
    const bucket = Number.isFinite(epoch) ? Math.floor(epoch / w) : `nan-${row.ts}`;
    const key = `${row.sessionId}::${bucket}`;
    let arr = buckets.get(key);
    if (arr === undefined) {
      arr = [];
      buckets.set(key, arr);
      order.push(key);
    }
    arr.push(row);
  }
  return order.map((k) => buckets.get(k)!);
}

/** Assemble a `<voice-context>` block from chronological chunks. */
export function buildContext(
  chronological: readonly TranscriptChunk[],
  query: TranscriptContextQuery,
): TranscriptContext {
  const maxChars = query.maxChars ?? TRANSCRIPT_CONTEXT_DEFAULT_MAX_CHARS;
  let chunks = [...chronological];
  // lastN keeps the most-recent N (slice from the end of the chrono list).
  if (query.lastN !== undefined && query.lastN >= 0 && chunks.length > query.lastN) {
    chunks = chunks.slice(chunks.length - query.lastN);
  }

  // Front-trim to fit maxChars (drop oldest first).
  let truncated = false;
  const lineOf = (c: TranscriptChunk): string => c.text;
  let joined = chunks.map(lineOf).join('\n');
  while (joined.length > maxChars && chunks.length > 0) {
    chunks.shift();
    truncated = true;
    joined = chunks.map(lineOf).join('\n');
  }

  let summaryCount = 0;
  let rawCount = 0;
  for (const c of chunks) {
    if (c.kind === 'summary') summaryCount += 1;
    else rawCount += 1;
  }
  return { text: joined, chunkCount: chunks.length, summaryCount, rawCount, truncated };
}

/** Coerce a possibly-unknown DB string into a valid `TranscriptKind`. */
export function coerceKind(raw: string): TranscriptKind {
  return KIND_SET.has(raw) ? (raw as TranscriptKind) : 'raw';
}

/** Coerce a possibly-unknown DB string into a valid `TranscriptSource`. */
export function coerceSource(raw: string): TranscriptSource {
  return SOURCE_SET.has(raw) ? (raw as TranscriptSource) : 'vad';
}
