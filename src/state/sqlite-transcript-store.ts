import type { Database, Statement } from 'better-sqlite3';
import {
  buildContext,
  capSummaryText,
  clampTranscriptLimit,
  clampTranscriptOffset,
  coerceKind,
  coerceSource,
  groupAgedChunks,
  TRANSCRIPT_CONTEXT_QUERY_LIMIT,
  type CompactionConfig,
  type CompactionResult,
  type Summarizer,
  type TranscriptChunk,
  type TranscriptChunkInput,
  type TranscriptContext,
  type TranscriptContextQuery,
  type TranscriptListFilter,
  type TranscriptSource,
  type TranscriptStore,
} from './transcript-store.js';

interface TranscriptRow {
  id: number;
  session_id: string;
  kind: string;
  ts: string;
  t_ms: number;
  text: string;
  source: string;
  span_start_ts: string | null;
  span_end_ts: string | null;
  raw_count: number;
  created_at: string;
}

function rowToChunk(row: TranscriptRow): TranscriptChunk {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: coerceKind(row.kind),
    ts: row.ts,
    tMs: row.t_ms,
    text: row.text,
    source: coerceSource(row.source),
    spanStartTs: row.span_start_ts,
    spanEndTs: row.span_end_ts,
    rawCount: row.raw_count,
    createdAt: row.created_at,
  };
}

const SELECT_COLS =
  'id, session_id, kind, ts, t_ms, text, source, span_start_ts, span_end_ts, raw_count, created_at';

/**
 * Phase 6D.1 — SQLite-backed rolling context buffer. Append-only from the
 * capture runner; `compact()` is the single mutation path. Mirrors
 * `createMemoryTranscriptStore` semantics exactly (audit-M4 parity).
 *
 * better-sqlite3 is synchronous, so `compact()` reads aged rows sync,
 * awaits the (async) summarizer OUTSIDE any transaction, then applies all
 * writes inside ONE `db.transaction(...)` keyed off the explicit row ids
 * captured before the await — anything appended during the await is
 * untouched.
 */
export class SqliteTranscriptStore implements TranscriptStore {
  private readonly stmts: {
    insertRaw: Statement;
    insertSummary: Statement;
    deleteById: Statement;
    deleteSession: Statement;
    countAll: Statement;
  };

  constructor(private readonly db: Database) {
    this.stmts = {
      insertRaw: db.prepare(
        `INSERT INTO transcript_chunks
           (session_id, kind, ts, t_ms, text, source, span_start_ts, span_end_ts, raw_count, created_at)
         VALUES
           (@session_id, 'raw', @ts, @t_ms, @text, @source, NULL, NULL, 0, @created_at)`,
      ),
      insertSummary: db.prepare(
        `INSERT INTO transcript_chunks
           (session_id, kind, ts, t_ms, text, source, span_start_ts, span_end_ts, raw_count, created_at)
         VALUES
           (@session_id, 'summary', @ts, @t_ms, @text, 'summary', @span_start_ts, @span_end_ts, @raw_count, @created_at)`,
      ),
      deleteById: db.prepare(`DELETE FROM transcript_chunks WHERE id = ?`),
      deleteSession: db.prepare(`DELETE FROM transcript_chunks WHERE session_id = ?`),
      countAll: db.prepare(`SELECT COUNT(*) AS c FROM transcript_chunks`),
    };
  }

  append(input: TranscriptChunkInput): TranscriptChunk {
    const source: TranscriptSource = coerceSource(input.source ?? 'vad');
    const createdAt = input.createdAt ?? input.ts;
    const info = this.stmts.insertRaw.run({
      session_id: input.sessionId,
      ts: input.ts,
      t_ms: input.tMs,
      text: input.text,
      source,
      created_at: createdAt,
    });
    return {
      id: Number(info.lastInsertRowid),
      sessionId: input.sessionId,
      kind: 'raw',
      ts: input.ts,
      tMs: input.tMs,
      text: input.text,
      source,
      spanStartTs: null,
      spanEndTs: null,
      rawCount: 0,
      createdAt,
    };
  }

  list(filter: TranscriptListFilter = {}): TranscriptChunk[] {
    const { clause, params } = buildWhere(filter);
    const limit = clampTranscriptLimit(filter.limit);
    const offset = clampTranscriptOffset(filter.offset);
    const dir = filter.order === 'asc' ? 'ASC' : 'DESC';
    const sql =
      `SELECT ${SELECT_COLS} FROM transcript_chunks${clause}` +
      ` ORDER BY ts ${dir}, id ${dir} LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params, limit, offset) as TranscriptRow[];
    return rows.map(rowToChunk);
  }

  count(filter: TranscriptListFilter = {}): number {
    const { clause, params } = buildWhere(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM transcript_chunks${clause}`)
      .get(...params) as { c: number };
    return row.c;
  }

  getContext(query: TranscriptContextQuery = {}): TranscriptContext {
    const filter: TranscriptListFilter = {
      ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
      ...(query.sinceMs !== undefined && query.now !== undefined
        ? { sinceTs: new Date(query.now - query.sinceMs).toISOString() }
        : {}),
    };
    const { clause, params } = buildWhere(filter);
    // Audit-C1: scan the MOST-RECENT `TRANSCRIPT_CONTEXT_QUERY_LIMIT` rows
    // (DESC + LIMIT), then reverse to chronological for `buildContext`.
    // An `ORDER BY ts ASC LIMIT N` would take the OLDEST N and silently
    // drop the recent transcripts the summon path actually needs.
    const sql =
      `SELECT ${SELECT_COLS} FROM transcript_chunks${clause}` +
      ` ORDER BY ts DESC, id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, TRANSCRIPT_CONTEXT_QUERY_LIMIT) as TranscriptRow[];
    rows.reverse(); // newest-first scan → chronological
    return buildContext(rows.map(rowToChunk), query);
  }

  async compact(
    now: number,
    summarize: Summarizer,
    config: CompactionConfig,
  ): Promise<CompactionResult> {
    const cutoffRaw = new Date(now - config.rawRetentionMs).toISOString();
    // 1. Read aged raw rows (sync).
    const aged = this.db
      .prepare(
        `SELECT ${SELECT_COLS} FROM transcript_chunks` +
          ` WHERE kind = 'raw' AND ts < ? ORDER BY ts ASC, id ASC`,
      )
      .all(cutoffRaw) as TranscriptRow[];

    // 2. Group + summarize (async, OUTSIDE any transaction).
    const groups = groupAgedChunks(
      aged.map((r) => ({ ...r, sessionId: r.session_id })),
      config.windowMs,
    );
    const pending: Array<{
      sessionId: string;
      summary: string;
      first: TranscriptRow & { sessionId: string };
      last: TranscriptRow & { sessionId: string };
      ids: number[];
    }> = [];
    for (const group of groups) {
      const summary = capSummaryText(
        await summarize(group.map((r) => r.text)),
        config.summaryMaxChars,
      );
      pending.push({
        sessionId: group[0]!.sessionId,
        summary,
        first: group[0]!,
        last: group[group.length - 1]!,
        ids: group.map((r) => r.id),
      });
    }

    // 3. Apply all writes in ONE transaction (delete by explicit id).
    const cutoffSummary = new Date(now - config.summaryRetentionMs).toISOString();
    const createdAt = new Date(now).toISOString();
    let summariesCreated = 0;
    let rawChunksRolledUp = 0;
    let summariesPruned = 0;
    let chunksEvicted = 0;

    const apply = this.db.transaction(() => {
      for (const p of pending) {
        for (const id of p.ids) this.stmts.deleteById.run(id);
        rawChunksRolledUp += p.ids.length;
        this.stmts.insertSummary.run({
          session_id: p.sessionId,
          ts: p.last.ts,
          t_ms: p.last.t_ms,
          text: p.summary,
          span_start_ts: p.first.ts,
          span_end_ts: p.last.ts,
          raw_count: p.ids.length,
          created_at: createdAt,
        });
        summariesCreated += 1;
      }

      summariesPruned = this.db
        .prepare(`DELETE FROM transcript_chunks WHERE kind = 'summary' AND ts < ?`)
        .run(cutoffSummary).changes;

      const total = (this.stmts.countAll.get() as { c: number }).c;
      if (total > config.maxChunks) {
        const excess = total - config.maxChunks;
        chunksEvicted = this.db
          .prepare(
            `DELETE FROM transcript_chunks WHERE id IN (` +
              `SELECT id FROM transcript_chunks ORDER BY ts ASC, id ASC LIMIT ?)`,
          )
          .run(excess).changes;
      }
    });
    apply();

    return { summariesCreated, rawChunksRolledUp, summariesPruned, chunksEvicted };
  }

  clearSession(sessionId: string): number {
    return this.stmts.deleteSession.run(sessionId).changes;
  }
}

function buildWhere(filter: TranscriptListFilter): { clause: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.sessionId !== undefined) {
    parts.push('session_id = ?');
    params.push(filter.sessionId);
  }
  if (filter.kinds !== undefined && filter.kinds.length > 0) {
    parts.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`);
    params.push(...filter.kinds);
  }
  if (filter.sinceTs !== undefined) {
    parts.push('ts >= ?');
    params.push(filter.sinceTs);
  }
  if (filter.untilTs !== undefined) {
    parts.push('ts <= ?');
    params.push(filter.untilTs);
  }
  const clause = parts.length === 0 ? '' : ` WHERE ${parts.join(' AND ')}`;
  return { clause, params };
}
