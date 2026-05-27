-- Phase 5E — cross-project sagas.
--
-- A "saga" binds N task records across one or more projects under a
-- single user-visible intent ("update API in projA and client in projB").
-- Each task can belong to AT MOST one saga (UNIQUE constraint on
-- saga_members.task_id). A saga rolls up its status from its members
-- via the SagaRollupListener wired on TaskStore.onTaskStatusChange:
--   - all members `completed`   → saga `completed`
--   - any member `failed`/`cancelled` → saga `failed`
--   - one+ member `in_progress` → saga `in_progress`
--   - all members `pending`     → saga `pending`
--
-- Membership is set at task-creation time only (`create_task(saga_id:?)`)
-- and is immutable thereafter — adding/removing members post-hoc would
-- race the rollup writer. PLAN.md §Phase 5E deferrals list `add_saga_member`
-- as a 5G follow-up.
--
-- Project deletion does NOT cascade to sagas — `saga_members.project_id
-- ON DELETE SET NULL` mirrors the existing `workers.project_id` pattern
-- (preserves audit history). The saga rollup tolerates `projectId = null`
-- (renders as `(unregistered)`).
--
-- The `tasks.id ON DELETE CASCADE` link IS load-bearing: deleting a task
-- (today: only via `symphony reset`) removes its saga membership row;
-- the saga itself survives so the audit log still has a target.
--
-- Status CHECK mirrors the `tasks` table's 5-state machine exactly.
-- Future migrations that swap-rebuild `sagas` MUST carry these columns
-- forward (same hazard class as 4G.1 migration 0007 + 4G.2 migration
-- 0008 + 5A migration 0009 + 3T migration 0005).

CREATE TABLE sagas (
  id            TEXT PRIMARY KEY,
  description   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_progress','completed','failed','cancelled')),
  result        TEXT,
  notes         TEXT NOT NULL DEFAULT '[]',  -- JSON array of {at, text}
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT,
  insertion_seq INTEGER NOT NULL
);

CREATE INDEX idx_sagas_status        ON sagas (status);
CREATE INDEX idx_sagas_insertion_seq ON sagas (insertion_seq);

CREATE TABLE saga_members (
  saga_id     TEXT NOT NULL REFERENCES sagas(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  project_id  TEXT REFERENCES projects(id) ON DELETE SET NULL,
  -- Cached snapshot of the task's status; updated by the rollup writer.
  -- NOT the source of truth (the tasks.status row is). The cache exists
  -- so the rollup query is a single JOIN-free read.
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','in_progress','completed','failed','cancelled')),
  added_at    TEXT NOT NULL,
  PRIMARY KEY (saga_id, task_id)
);

CREATE INDEX idx_saga_members_task    ON saga_members (task_id);
CREATE INDEX idx_saga_members_saga    ON saga_members (saga_id);
CREATE INDEX idx_saga_members_project ON saga_members (project_id);
