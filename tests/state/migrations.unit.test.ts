import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations, MigrationError, readMigrationFiles } from '../../src/state/migrations.js';

function tmpMigrationsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-mig-'));
}

describe('migrations', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpMigrationsDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('readMigrationFiles returns files sorted lexically with sha256 hashes', () => {
    fs.writeFileSync(path.join(dir, '0002_b.sql'), 'CREATE TABLE b (id INTEGER);');
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    const files = readMigrationFiles(dir);
    expect(files.map((f) => f.filename)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(files[0]!.hash).toBe(
      createHash('sha256').update('CREATE TABLE a (id INTEGER);').digest('hex'),
    );
  });

  it('throws a helpful error when the directory does not exist', () => {
    expect(() => readMigrationFiles(path.join(dir, 'nope'))).toThrow(/not found/i);
  });

  it('applies unapplied migrations and skips already-applied ones by hash', () => {
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    const db = new Database(':memory:');
    const first = applyMigrations(db, dir);
    expect(first.appliedCount).toBe(1);
    expect(first.totalMigrations).toBe(1);

    // second run: zero applied, one total
    const second = applyMigrations(db, dir);
    expect(second.appliedCount).toBe(0);
    expect(second.totalMigrations).toBe(1);

    // Table exists; if migration re-ran we'd hit "table already exists"
    expect(() => db.exec('INSERT INTO a (id) VALUES (1)')).not.toThrow();
    db.close();
  });

  it('applies a late-added migration with an earlier lex-sort (not emdash scenario, but parity)', () => {
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    const db = new Database(':memory:');
    applyMigrations(db, dir);
    fs.writeFileSync(path.join(dir, '0002_b.sql'), 'CREATE TABLE b (id INTEGER);');
    const summary = applyMigrations(db, dir);
    expect(summary.appliedCount).toBe(1);
    expect(summary.totalMigrations).toBe(2);
    db.close();
  });

  it('re-applying a migration whose content changed treats it as a NEW hash (applies again)', () => {
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    const db = new Database(':memory:');
    applyMigrations(db, dir);
    // Drop + change content — the new hash is unseen, so it'll re-apply.
    db.exec('DROP TABLE a');
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER, name TEXT);');
    const summary = applyMigrations(db, dir);
    expect(summary.appliedCount).toBe(1);
    // Confirm the new schema shape landed.
    const info = db.prepare(`PRAGMA table_info(a)`).all() as { name: string }[];
    expect(info.map((r) => r.name).sort()).toEqual(['id', 'name']);
    db.close();
  });

  it('disables foreign keys during migration and restores them on success', () => {
    fs.writeFileSync(
      path.join(dir, '0001_a.sql'),
      `CREATE TABLE parent (id INTEGER PRIMARY KEY);
       CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
       INSERT INTO child (id, parent_id) VALUES (1, 999);  -- dangling FK pre-enable`,
    );
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    expect(() => applyMigrations(db, dir)).not.toThrow();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('restores foreign keys on failure', () => {
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    fs.writeFileSync(path.join(dir, '0002_bad.sql'), 'THIS IS NOT SQL;');
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    expect(() => applyMigrations(db, dir)).toThrow(MigrationError);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('wraps each migration in a transaction — bad migration does NOT leave partial tables', () => {
    fs.writeFileSync(
      path.join(dir, '0001_partial.sql'),
      `CREATE TABLE ok (id INTEGER);
       INSERT INTO nonexistent (x) VALUES (1);`,
    );
    const db = new Database(':memory:');
    expect(() => applyMigrations(db, dir)).toThrow(MigrationError);
    const rows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ok','nonexistent')`)
      .all();
    expect(rows).toHaveLength(0);
    db.close();
  });

  it('tracking table stores hash, filename, applied_at', () => {
    fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    const db = new Database(':memory:');
    applyMigrations(db, dir);
    const rows = db
      .prepare(`SELECT hash, filename, applied_at FROM __symphony_migrations`)
      .all() as { hash: string; filename: string; applied_at: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.filename).toBe('0001_a.sql');
    expect(rows[0]!.hash).toHaveLength(64);
    expect(() => new Date(rows[0]!.applied_at).toISOString()).not.toThrow();
    db.close();
  });

  it(
    'concurrent open of the same DB file — only one process applies migrations, the other skips (audit C1)',
    async () => {
      // Single file DB with busy_timeout so the two processes can race.
      // We simulate two processes by opening two connections to the same
      // on-disk file; `applyMigrations` wraps the read + apply in an
      // EXCLUSIVE transaction so the loser sees the winner's inserts.
      fs.writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);');
      fs.writeFileSync(
        path.join(dir, '0002_b.sql'),
        'CREATE TABLE b (id INTEGER);',
      );
      const file = path.join(dir, 'race.db');
      const connA = new Database(file);
      const connB = new Database(file);
      try {
        connA.pragma('busy_timeout = 5000');
        connB.pragma('busy_timeout = 5000');
        // Fire both applyMigrations calls concurrently.
        const [a, b] = await Promise.all([
          Promise.resolve().then(() => applyMigrations(connA, dir)),
          Promise.resolve().then(() => applyMigrations(connB, dir)),
        ]);
        // Exactly one process applies both migrations, the other sees zero.
        const appliedCounts = [a.appliedCount, b.appliedCount].sort();
        expect(appliedCounts).toEqual([0, 2]);
        // Tables exist exactly once.
        const tables = connA
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('a','b')`,
          )
          .all() as { name: string }[];
        expect(tables.map((t) => t.name).sort()).toEqual(['a', 'b']);
        // Tracking table has exactly 2 hashes (no duplicate inserts).
        const trackerRows = connA
          .prepare(`SELECT hash FROM __symphony_migrations`)
          .all() as { hash: string }[];
        expect(trackerRows).toHaveLength(2);
      } finally {
        connA.close();
        connB.close();
      }
    },
  );
});
