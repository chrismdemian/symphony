-- Phase 4G.1 — audit attempts counter.
--
-- `audit_changes` (src/orchestrator/tools/audit-changes.ts) auto-bumps
-- this counter on every audit invocation for a given worker — PASS or
-- FAIL alike. Maestro reads the value off `AuditResult.auditAttempts` and
-- applies the 3-FAIL-then-escalate rule via its prompt. The counter is
-- monotonic per worker; resume does NOT reset (rationale: an N-th audit
-- on the same worker's diff has historical context the cap-rule wants).
--
-- Additive ALTER — no swap-rebuild needed since there's no CHECK
-- constraint on this column. NOT NULL DEFAULT 0 backfills cleanly across
-- every existing row.
--
-- No index — the column is read pointwise (`WHERE id = ?`) via
-- `SqliteWorkerStore.get`, never aggregated.

ALTER TABLE workers ADD COLUMN audit_attempts INTEGER NOT NULL DEFAULT 0;
