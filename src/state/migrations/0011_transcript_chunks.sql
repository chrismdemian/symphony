-- Phase 6D.1 — Rolling context buffer: durable, queryable store of
-- VAD-gated ambient transcripts produced by `symphony voice capture`.
--
-- Design:
--   - No foreign keys: transcript rows are session-scoped (the bridge's
--     per-run `session_id`), not tied to any project/worker/task. They
--     outlive nothing and reference nothing. `symphony reset` wipes the
--     whole DB, which is the intended clean-slate for ephemeral ambient
--     transcripts.
--   - Raw audio is NEVER stored — only the transcribed `text`. The
--     bridge holds PCM in memory and discards it after STT (6A/6B). This
--     table is text-only by construction (no BLOB column exists).
--   - Two kinds in one table:
--       'raw'     — one row per VAD/wake STT `final` event.
--       'summary' — a local rollup of N aged raw rows (compaction). The
--                   raw rows it covers are deleted; the summary's `ts` is
--                   the span's END so it sorts in chronological place.
--   - `t_ms` is the bridge's monotonic "ms since ready" clock (same wire
--     contract as 6A/6B/6C events). `ts` is ISO 8601 wall-clock — the
--     retention + getContext queries key off `ts`.
--   - Three indexes target the query axes: per-session reverse-chrono
--     scan (getContext), global reverse-chrono (cross-session list), and
--     kind-scoped (compaction reads aged 'raw' rows).
--   - Retention is enforced in TypeScript (`TranscriptStore.compact`),
--     NOT a SQL trigger: summarization needs a function call the DB can't
--     make, and the maxChunks ceiling is applied in the same pass.

CREATE TABLE transcript_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'raw'
                CHECK (kind IN ('raw','summary')),
  ts            TEXT NOT NULL,
  t_ms          INTEGER NOT NULL DEFAULT 0,
  text          TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'vad'
                CHECK (source IN ('vad','wake','summary')),
  span_start_ts TEXT,
  span_end_ts   TEXT,
  raw_count     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_transcript_session_ts ON transcript_chunks (session_id, ts DESC);
CREATE INDEX idx_transcript_ts         ON transcript_chunks (ts DESC);
CREATE INDEX idx_transcript_kind_ts    ON transcript_chunks (kind, ts DESC);
