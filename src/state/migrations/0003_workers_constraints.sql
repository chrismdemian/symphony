-- Phase 2B.1b m2/m3 follow-up — workers.status CHECK constraint + autonomy_tier DEFAULT alignment.
--
-- Why a new table swap: SQLite has no ALTER TABLE ADD CONSTRAINT and
-- can't change a column DEFAULT in place. The standard idiom is
-- create-new → copy-rows → drop-old → rename-new (atomic inside the
-- migration runner's EXCLUSIVE transaction).
--
-- Why now: 2B.1 reserved both fields without enforcement. 2B.1b started
-- writing real worker rows, so the latent drift between the runtime
-- default (autonomyTier=1) and the schema DEFAULT (=2) is now a true
-- inconsistency, and a typo'd status would persist silently.

-- Disable FK checks so the temp-table swap doesn't trigger cascades on
-- referencing tables (project_id / task_id from tasks etc.). The
-- migration runner re-enables `foreign_keys = ON` after applying.

CREATE TABLE workers_new (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id            TEXT REFERENCES tasks(id)   ON DELETE SET NULL,
  session_id         TEXT,
  worktree_path      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'spawning'
                     CHECK (status IN ('spawning','running','completed','failed','killed','timeout','crashed')),
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
  cost_usd           REAL
);

INSERT INTO workers_new (
  id, project_id, task_id, session_id, worktree_path, status, role,
  feature_intent, task_description, model, autonomy_tier, depends_on,
  created_at, completed_at, last_event_at, exit_code, exit_signal, cost_usd
)
SELECT
  id, project_id, task_id, session_id, worktree_path,
  -- Defensive: any pre-existing row with a status outside the new
  -- enum gets coerced to 'crashed' (the catch-all terminal). Unlikely
  -- because 2B.1b's WorkerRegistry.markCompleted only writes from the
  -- WorkerStatus union, but the CHECK constraint would otherwise
  -- abort the entire migration.
  CASE
    WHEN status IN ('spawning','running','completed','failed','killed','timeout','crashed')
      THEN status
    ELSE 'crashed'
  END,
  role, feature_intent, task_description, model, autonomy_tier, depends_on,
  created_at, completed_at, last_event_at, exit_code, exit_signal, cost_usd
FROM workers;

DROP INDEX IF EXISTS idx_workers_project_status;
DROP TABLE workers;
ALTER TABLE workers_new RENAME TO workers;
CREATE INDEX idx_workers_project_status ON workers (project_id, status);
