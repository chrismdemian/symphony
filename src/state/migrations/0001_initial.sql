-- Phase 2B.1 — initial Symphony schema.
--
-- Ground-truth storage for every record currently living in-memory behind
-- the Phase 2A stores (`ProjectStore`, `TaskStore`, `QuestionStore`,
-- `WaveStore`). Workers are SCHEMA-ONLY this migration — the runtime
-- `WorkerRegistry` still holds live `Worker` handles and `CircularBuffer`
-- state; the `workers` table is reserved for a future 2B.1b that persists
-- metadata + session_id for crash recovery.
--
-- Reserved tables (no live writer in 2B.1): `workers`, `conversations`,
-- `messages`, `sessions`. They exist so that follow-ups don't need a
-- second "initial" migration later.
--
-- Statement splitting: this file is applied as one `db.exec()` call inside
-- a single BEGIN/COMMIT transaction. No Drizzle-style breakpoints needed.

CREATE TABLE projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  path               TEXT NOT NULL UNIQUE,
  git_remote         TEXT,
  git_branch         TEXT,
  base_ref           TEXT,
  default_model      TEXT,
  lint_command       TEXT,
  test_command       TEXT,
  build_command      TEXT,
  verify_command     TEXT,
  verify_timeout_ms  INTEGER,
  finalize_default   TEXT CHECK (finalize_default IS NULL OR finalize_default IN ('push','merge')),
  created_at         TEXT NOT NULL
);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  description    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_progress','completed','failed','cancelled')),
  priority       INTEGER NOT NULL DEFAULT 0,
  worker_id      TEXT,
  depends_on     TEXT NOT NULL DEFAULT '[]',   -- JSON array of task ids
  notes          TEXT NOT NULL DEFAULT '[]',   -- JSON array of {at, text}
  result         TEXT,
  archived_at    TEXT,                          -- reserved; Phase 8 soft-delete
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  completed_at   TEXT,
  insertion_seq  INTEGER NOT NULL
);

CREATE INDEX idx_tasks_project_status ON tasks (project_id, status);
CREATE INDEX idx_tasks_insertion_seq  ON tasks (insertion_seq);

-- Reserved: no live writer in 2B.1.
CREATE TABLE workers (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id            TEXT REFERENCES tasks(id)   ON DELETE SET NULL,
  session_id         TEXT,
  worktree_path      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'spawning',
  role               TEXT NOT NULL,
  feature_intent     TEXT NOT NULL,
  task_description   TEXT NOT NULL,
  model              TEXT,
  autonomy_tier      INTEGER NOT NULL DEFAULT 2,
  depends_on         TEXT NOT NULL DEFAULT '[]',
  created_at         TEXT NOT NULL,
  completed_at       TEXT,
  last_event_at      TEXT,
  exit_code          INTEGER,
  exit_signal        TEXT,
  cost_usd           REAL
);
CREATE INDEX idx_workers_project_status ON workers (project_id, status);

CREATE TABLE questions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  worker_id       TEXT,                                -- no FK; worker rows are a separate 2B.1b
  question        TEXT NOT NULL,
  context         TEXT,
  urgency         TEXT NOT NULL DEFAULT 'blocking' CHECK (urgency IN ('blocking','advisory')),
  asked_at        TEXT NOT NULL,
  answered        INTEGER NOT NULL DEFAULT 0 CHECK (answered IN (0,1)),
  answer          TEXT,
  answered_at     TEXT,
  insertion_seq   INTEGER NOT NULL
);
CREATE INDEX idx_questions_answered  ON questions (answered);
CREATE INDEX idx_questions_insertion ON questions (insertion_seq);

CREATE TABLE waves (
  id              TEXT PRIMARY KEY,
  topic           TEXT NOT NULL,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,
  worker_ids      TEXT NOT NULL,                       -- JSON array, length 1..7
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  insertion_seq   INTEGER NOT NULL
);
CREATE INDEX idx_waves_finished ON waves (finished_at);
CREATE INDEX idx_waves_insertion ON waves (insertion_seq);

-- Reserved: Phase 3 session persistence.
CREATE TABLE sessions (
  id                         TEXT PRIMARY KEY,
  orchestrator_session_id    TEXT,
  started_at                 TEXT NOT NULL,
  ended_at                   TEXT,
  state                      TEXT                     -- JSON blob
);

-- Reserved: Phase 3 conversations (multiple chats per task for TUI replay).
CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title           TEXT,
  is_main         INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0,1)),
  is_active       INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  display_order   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  archived_at     TEXT
);
CREATE UNIQUE INDEX idx_conversations_main_per_task
  ON conversations (task_id) WHERE is_main = 1;
CREATE UNIQUE INDEX idx_conversations_active_per_task
  ON conversations (task_id) WHERE is_active = 1;

-- Reserved: Phase 3 message replay.
CREATE TABLE messages (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role               TEXT NOT NULL,
  content            TEXT,
  metadata           TEXT,                                -- JSON
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages (conversation_id, created_at);
