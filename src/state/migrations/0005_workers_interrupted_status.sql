-- Phase 3T — workers.status CHECK gains 'interrupted'.
--
-- 'interrupted' is the terminal status assigned when a worker is killed
-- by a user-initiated pivot (Esc / Ctrl+C during Maestro streaming). It
-- is distinct from 'killed' (explicit single-worker kill) and 'crashed'
-- (unexpected exit), so Maestro's list_workers can re-dispatch workers
-- whose tasks the user wants to pursue under a new direction.
--
-- Why a swap-rebuild: SQLite has no ALTER TABLE ALTER CONSTRAINT. Same
-- pattern as migration 0003 (constraint addition) — carrying forward
-- the 0004-added token columns so they survive the rebuild.

CREATE TABLE workers_new (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id            TEXT REFERENCES tasks(id)   ON DELETE SET NULL,
  session_id         TEXT,
  worktree_path      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'spawning'
                     CHECK (status IN ('spawning','running','completed','failed','killed','timeout','crashed','interrupted')),
  role               TEXT NOT NULL,
  feature_intent     TEXT NOT NULL,
  task_description   TEXT NOT NULL,
  model              TEXT,
  autonomy_tier      INTEGER NOT NULL DEFAULT 1,
  depends_on         TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  completed_at       TEXT,
  last_event_at      TEXT,
  exit_code          INTEGER,
  exit_signal        TEXT,
  cost_usd           REAL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER
);

INSERT INTO workers_new (
  id, project_id, task_id, session_id, worktree_path, status, role,
  feature_intent, task_description, model, autonomy_tier, depends_on,
  created_at, completed_at, last_event_at, exit_code, exit_signal, cost_usd,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
)
SELECT
  id, project_id, task_id, session_id, worktree_path,
  CASE
    WHEN status IN ('spawning','running','completed','failed','killed','timeout','crashed','interrupted')
      THEN status
    ELSE 'crashed'
  END,
  role, feature_intent, task_description, model, autonomy_tier, depends_on,
  created_at, completed_at, last_event_at, exit_code, exit_signal, cost_usd,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
FROM workers;

DROP INDEX IF EXISTS idx_workers_project_status;
DROP TABLE workers;
ALTER TABLE workers_new RENAME TO workers;
CREATE INDEX idx_workers_project_status ON workers (project_id, status);
