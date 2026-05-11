-- Phase 3N.1 — token usage persistence.
--
-- Mirrors the existing `cost_usd` column (2B.1b m1) for the four token
-- counters reported by Claude's stream-json `result.usage` payload. The
-- numbers are CUMULATIVE for the worker's session, last-wins semantics —
-- the parser already accumulates `usageByModel` separately and exposes
-- `sessionUsage` as the authoritative roll-up (`workers/stream-parser.ts`).
--
-- All four columns are nullable INTEGER. A worker that never reaches a
-- `result` event (early crash, SIGKILL before turn-complete) stays NULL
-- across the row. `replace()` (resume) explicitly NULLs them so the
-- audit trail doesn't carry the prior run's cumulative counts forward,
-- matching `cost_usd`'s pattern.
--
-- No CHECK constraint: a worker with 0 tokens is a valid state during
-- spawn → first-turn. SUM-aggregating queries treat NULL as 0 via
-- `COALESCE(SUM(...), 0)` at the read site.
--
-- No index: the only aggregation today is `GROUP BY project_id` for
-- `/stats by project` (Phase 3N.3), which already uses
-- `idx_workers_project_status` from 0001.

ALTER TABLE workers ADD COLUMN input_tokens       INTEGER;
ALTER TABLE workers ADD COLUMN output_tokens      INTEGER;
ALTER TABLE workers ADD COLUMN cache_read_tokens  INTEGER;
ALTER TABLE workers ADD COLUMN cache_write_tokens INTEGER;
