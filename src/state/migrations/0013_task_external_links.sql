-- Phase 8A — task ↔ external-source link table.
--
-- The bridge between a Symphony task and the external item it was synced
-- from (a Notion page in 8A; Linear/Jira/GitHub issues in 8C). It serves
-- two purposes:
--
--   1. Idempotent sync — `sync_notion` skips any Notion page whose id is
--      already linked, so re-running the sync never creates duplicate
--      Symphony tasks. The (source, external_id) primary key IS the dedup
--      key.
--   2. Bidirectional writeback — when a task transitions to a terminal
--      status, Symphony looks up its link and (for source='notion') pushes
--      the status back to the Notion page. `data_source_id` is stored so
--      the writeback can re-resolve the page's parent data source without
--      another `databases.retrieve` round-trip; `url` is kept for chat/audit
--      display.
--
-- Generic by design (the `source` column) so all six Phase 8C connectors
-- reuse this table rather than adding columns to the hot `tasks` schema.
--
-- ON DELETE CASCADE is hygiene, not load-bearing — an orphaned link is
-- harmless (it's pure metadata) and `symphony reset` wipes the DB. FK is
-- disabled during migration and re-enabled after (see migrations.ts).

CREATE TABLE IF NOT EXISTS task_external_links (
  task_id        TEXT NOT NULL,
  source         TEXT NOT NULL,
  external_id    TEXT NOT NULL,
  data_source_id TEXT,
  url            TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (source, external_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Writeback path looks up by Symphony task id (the onTaskStatusChange
-- callback only knows the task). One link per (task_id, source).
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_external_links_task_source
  ON task_external_links (task_id, source);
