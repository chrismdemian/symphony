-- Phase 3R — Audit log: persistent, queryable record of every Symphony
-- action. Foundation for Phase 7's "non-defeatable audit before
-- dispatch" envelope (PLAN.md §Phase 7 capability flags).
--
-- Design:
--   - No foreign keys: audit rows OUTLIVE the entities they reference.
--     `symphony reset` preserves audit_log (per 3Q rule); workers + tasks
--     + projects can disappear while their history remains.
--   - `headline` is denormalized so /log can render rows without joining.
--   - `payload` carries sanitized JSON for expand-row inspection.
--   - Three indexes target the three filter axes /log offers:
--       (ts DESC) for default reverse-chrono scan
--       (project_id, ts DESC) for --project filter
--       (kind, ts DESC) for --type filter
--   - Retention trigger caps the table at 10k rows. No age cap.
--     Flat-file mirror at ~/.symphony/audit.log is unbounded for cold
--     grep. Trigger fires once per insert; cheap on a small table.

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'info'
              CHECK (severity IN ('info','warn','error')),
  project_id  TEXT,
  worker_id   TEXT,
  task_id     TEXT,
  tool_name   TEXT,
  headline    TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_audit_ts          ON audit_log (ts DESC);
CREATE INDEX idx_audit_project_ts  ON audit_log (project_id, ts DESC);
CREATE INDEX idx_audit_kind_ts     ON audit_log (kind, ts DESC);

CREATE TRIGGER audit_log_cap AFTER INSERT ON audit_log
BEGIN
  DELETE FROM audit_log WHERE id <= NEW.id - 10000;
END;
