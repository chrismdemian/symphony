import type { Database, Statement } from 'better-sqlite3';
import type {
  CreateExternalLinkInput,
  ExternalLinkStore,
  TaskExternalLink,
} from './external-link-store.js';

interface ExternalLinkRow {
  task_id: string;
  source: string;
  external_id: string;
  data_source_id: string | null;
  url: string | null;
  created_at: string;
}

export interface SqliteExternalLinkStoreOptions {
  readonly now?: () => number;
}

/**
 * SQLite-backed `ExternalLinkStore` (migration 0013). `link()` is an
 * idempotent upsert on the `(source, external_id)` primary key — a
 * re-sync of the same Notion page updates taskId/dataSourceId/url in
 * place while preserving the original `created_at`. Behavior-identical to
 * `MemoryExternalLinkStore`.
 */
export class SqliteExternalLinkStore implements ExternalLinkStore {
  private readonly stmts: {
    upsert: Statement;
    selectByExternal: Statement;
    selectByTask: Statement;
    selectIdsBySource: Statement;
  };
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    opts: SqliteExternalLinkStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.stmts = {
      // ON CONFLICT preserves the original created_at (it is NOT in the
      // SET list) so a re-link keeps the first-seen timestamp.
      upsert: db.prepare(
        `INSERT INTO task_external_links
           (task_id, source, external_id, data_source_id, url, created_at)
         VALUES
           (@task_id, @source, @external_id, @data_source_id, @url, @created_at)
         ON CONFLICT(source, external_id) DO UPDATE SET
           task_id        = excluded.task_id,
           data_source_id = excluded.data_source_id,
           url            = excluded.url`,
      ),
      selectByExternal: db.prepare(
        `SELECT * FROM task_external_links WHERE source = ? AND external_id = ?`,
      ),
      selectByTask: db.prepare(
        `SELECT * FROM task_external_links WHERE task_id = ?`,
      ),
      selectIdsBySource: db.prepare(
        `SELECT external_id FROM task_external_links WHERE source = ?`,
      ),
    };
  }

  link(input: CreateExternalLinkInput): TaskExternalLink {
    const iso = new Date(this.now()).toISOString();
    this.stmts.upsert.run({
      task_id: input.taskId,
      source: input.source,
      external_id: input.externalId,
      data_source_id: input.dataSourceId ?? null,
      url: input.url ?? null,
      created_at: iso,
    });
    const stored = this.getByExternal(input.source, input.externalId);
    if (stored === undefined) {
      throw new Error('SqliteExternalLinkStore.link: post-upsert row vanished');
    }
    return stored;
  }

  listByTaskId(taskId: string): readonly TaskExternalLink[] {
    const rows = this.stmts.selectByTask.all(taskId) as ExternalLinkRow[];
    return rows.map(rowToLink);
  }

  getByExternal(source: string, externalId: string): TaskExternalLink | undefined {
    const row = this.stmts.selectByExternal.get(source, externalId) as
      | ExternalLinkRow
      | undefined;
    return row ? rowToLink(row) : undefined;
  }

  listExternalIds(source: string): Set<string> {
    const rows = this.stmts.selectIdsBySource.all(source) as { external_id: string }[];
    const ids = new Set<string>();
    for (const row of rows) ids.add(row.external_id);
    return ids;
  }
}

function rowToLink(row: ExternalLinkRow): TaskExternalLink {
  return {
    taskId: row.task_id,
    source: row.source,
    externalId: row.external_id,
    createdAt: row.created_at,
    ...(row.data_source_id !== null ? { dataSourceId: row.data_source_id } : {}),
    ...(row.url !== null ? { url: row.url } : {}),
  };
}
