-- Phase 2B.1 reservation for Phase 8 automations + run logs.
-- Schema lands now so Phase 8 doesn't need a second initial migration.

CREATE TABLE automations (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  prompt             TEXT NOT NULL,
  schedule           TEXT,                                 -- cron expression OR null
  trigger_type       TEXT,                                 -- null | github_pr | linear_issue | ...
  trigger_config     TEXT,                                 -- JSON per-trigger filters
  next_run_at        TEXT,
  last_run_at        TEXT,
  last_run_result    TEXT,
  run_count          INTEGER NOT NULL DEFAULT 0,
  in_flight          INTEGER NOT NULL DEFAULT 0 CHECK (in_flight IN (0,1)),
  enabled            INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at         TEXT NOT NULL
);

CREATE TABLE automation_run_logs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  automation_id      TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  task_id            TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  started_at         TEXT NOT NULL,
  finished_at        TEXT,
  status             TEXT,                                 -- success | failure | skipped
  error              TEXT,
  trigger_event      TEXT                                  -- JSON of the firing event
);
CREATE INDEX idx_arl_automation ON automation_run_logs (automation_id, started_at DESC);
