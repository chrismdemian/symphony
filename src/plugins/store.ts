import type { Database, Statement } from 'better-sqlite3';

/**
 * Phase 7A — installed-plugin registry store (migration 0012).
 *
 * Source of truth for "what is installed + is it enabled". The on-disk
 * manifest is the source of truth for "what the plugin is/does". The
 * store is intentionally thin: id-keyed CRUD + the enabled toggle. better-
 * sqlite3 is synchronous, so every method is sync.
 */

export interface PluginRecord {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly installedAt: string;
  readonly updatedAt: string;
}

export interface PluginUpsertInput {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly source: string;
  /** Defaults to false (default-deny) on first install; preserved on re-install. */
  readonly enabled?: boolean;
  /** ISO timestamp; caller supplies (no `Date.now()` inside the store core). */
  readonly now: string;
}

export interface PluginStore {
  list(): PluginRecord[];
  listEnabled(): PluginRecord[];
  get(id: string): PluginRecord | undefined;
  /** Insert or update by id. Returns the resulting record. */
  upsert(input: PluginUpsertInput): PluginRecord;
  /** Flip the enabled flag. Returns true when a row was updated. */
  setEnabled(id: string, enabled: boolean, now: string): boolean;
  /** Delete by id. Returns true when a row was removed. */
  delete(id: string): boolean;
}

interface PluginRow {
  id: string;
  name: string;
  version: string;
  source: string;
  enabled: number;
  installed_at: string;
  updated_at: string;
}

const SELECT_COLS = 'id, name, version, source, enabled, installed_at, updated_at';

function rowToRecord(row: PluginRow): PluginRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    source: row.source,
    enabled: row.enabled === 1,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

export class SqlitePluginStore implements PluginStore {
  private readonly stmts: {
    selectAll: Statement;
    selectEnabled: Statement;
    selectOne: Statement;
    insert: Statement;
    update: Statement;
    setEnabled: Statement;
    delete: Statement;
  };

  constructor(private readonly db: Database) {
    this.stmts = {
      selectAll: db.prepare(`SELECT ${SELECT_COLS} FROM plugins ORDER BY id ASC`),
      selectEnabled: db.prepare(
        `SELECT ${SELECT_COLS} FROM plugins WHERE enabled = 1 ORDER BY id ASC`,
      ),
      selectOne: db.prepare(`SELECT ${SELECT_COLS} FROM plugins WHERE id = ?`),
      insert: db.prepare(
        `INSERT INTO plugins (id, name, version, source, enabled, installed_at, updated_at)
         VALUES (@id, @name, @version, @source, @enabled, @now, @now)`,
      ),
      // Re-install: preserve installed_at + the existing enabled flag,
      // refresh name/version/source/updated_at.
      update: db.prepare(
        `UPDATE plugins
            SET name = @name, version = @version, source = @source, updated_at = @now
          WHERE id = @id`,
      ),
      setEnabled: db.prepare(
        `UPDATE plugins SET enabled = @enabled, updated_at = @now WHERE id = @id`,
      ),
      delete: db.prepare(`DELETE FROM plugins WHERE id = ?`),
    };
  }

  list(): PluginRecord[] {
    return (this.stmts.selectAll.all() as PluginRow[]).map(rowToRecord);
  }

  listEnabled(): PluginRecord[] {
    return (this.stmts.selectEnabled.all() as PluginRow[]).map(rowToRecord);
  }

  get(id: string): PluginRecord | undefined {
    const row = this.stmts.selectOne.get(id) as PluginRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  upsert(input: PluginUpsertInput): PluginRecord {
    const existing = this.get(input.id);
    if (existing === undefined) {
      this.stmts.insert.run({
        id: input.id,
        name: input.name,
        version: input.version,
        source: input.source,
        enabled: input.enabled === true ? 1 : 0,
        now: input.now,
      });
    } else {
      this.stmts.update.run({
        id: input.id,
        name: input.name,
        version: input.version,
        source: input.source,
        now: input.now,
      });
      // Re-install may also explicitly set enabled.
      if (input.enabled !== undefined && input.enabled !== existing.enabled) {
        this.stmts.setEnabled.run({ id: input.id, enabled: input.enabled ? 1 : 0, now: input.now });
      }
    }
    const result = this.get(input.id);
    if (result === undefined) {
      throw new Error(`plugin upsert failed to persist id '${input.id}'`);
    }
    return result;
  }

  setEnabled(id: string, enabled: boolean, now: string): boolean {
    return this.stmts.setEnabled.run({ id, enabled: enabled ? 1 : 0, now }).changes > 0;
  }

  delete(id: string): boolean {
    return this.stmts.delete.run(id).changes > 0;
  }
}
