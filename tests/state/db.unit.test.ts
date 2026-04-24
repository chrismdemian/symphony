import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SymphonyDatabase, validateSchemaContract } from '../../src/state/db.js';
import { DatabaseSchemaMismatchError } from '../../src/state/errors.js';
import { resolveDatabasePath } from '../../src/state/path.js';

function tmpFile(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-db-')),
    'symphony.db',
  );
}

describe('SymphonyDatabase', () => {
  const originalEnv = process.env.SYMPHONY_DB_FILE;
  const files: string[] = [];

  beforeEach(() => {
    delete process.env.SYMPHONY_DB_FILE;
  });

  afterEach(() => {
    if (originalEnv !== undefined) process.env.SYMPHONY_DB_FILE = originalEnv;
    else delete process.env.SYMPHONY_DB_FILE;
    for (const f of files.splice(0)) {
      try {
        fs.rmSync(path.dirname(f), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('open() creates the DB file, applies migrations, validates the contract', () => {
    const file = tmpFile();
    files.push(file);
    expect(fs.existsSync(file)).toBe(false);
    const svc = SymphonyDatabase.open({ filePath: file });
    try {
      expect(fs.existsSync(file)).toBe(true);
      expect(svc.migrationSummary.appliedCount).toBeGreaterThan(0);
      // Schema contract table → projects must exist with the expected columns
      const projectsInfo = svc.db.prepare(`PRAGMA table_info(projects)`).all() as {
        name: string;
      }[];
      expect(projectsInfo.map((r) => r.name)).toContain('lint_command');
      expect(projectsInfo.map((r) => r.name)).toContain('verify_command');
    } finally {
      svc.close();
    }
  });

  it('open() is idempotent across restarts — second open applies 0 migrations', () => {
    const file = tmpFile();
    files.push(file);
    const first = SymphonyDatabase.open({ filePath: file });
    const totalMigrations = first.migrationSummary.totalMigrations;
    first.close();

    const second = SymphonyDatabase.open({ filePath: file });
    try {
      expect(second.migrationSummary.appliedCount).toBe(0);
      expect(second.migrationSummary.totalMigrations).toBe(totalMigrations);
    } finally {
      second.close();
    }
  });

  it('enables WAL + sets busy_timeout and foreign_keys', () => {
    const file = tmpFile();
    files.push(file);
    const svc = SymphonyDatabase.open({ filePath: file, busyTimeoutMs: 7000 });
    try {
      expect(svc.db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(svc.db.pragma('busy_timeout', { simple: true })).toBe(7000);
      expect(svc.db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      svc.close();
    }
  });

  it('close() is safe to call twice', () => {
    const file = tmpFile();
    files.push(file);
    const svc = SymphonyDatabase.open({ filePath: file });
    svc.close();
    expect(() => svc.close()).not.toThrow();
  });

  it('validateSchemaContract throws DatabaseSchemaMismatchError when tables are absent', () => {
    const file = tmpFile();
    files.push(file);
    const db = new Database(file);
    try {
      expect(() => validateSchemaContract(db, file)).toThrow(DatabaseSchemaMismatchError);
      try {
        validateSchemaContract(db, file);
      } catch (err) {
        const e = err as DatabaseSchemaMismatchError;
        expect(e.dbPath).toBe(file);
        expect(e.missingInvariants).toContain('projects table');
        expect(e.code).toBe('DB_SCHEMA_MISMATCH');
      }
    } finally {
      db.close();
    }
  });

  it('validateSchemaContract throws when a required column is missing from an existing table', () => {
    const file = tmpFile();
    files.push(file);
    const db = new Database(file);
    // Deliberately create a degenerate `projects` table without `lint_command`.
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT);
             CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, status TEXT,
               priority INTEGER, depends_on TEXT, notes TEXT, archived_at TEXT);
             CREATE TABLE questions (id TEXT, urgency TEXT, answered INTEGER, asked_at TEXT);
             CREATE TABLE waves (id TEXT, topic TEXT, worker_ids TEXT, started_at TEXT);
             CREATE TABLE workers (id TEXT);
             CREATE TABLE conversations (id TEXT);
             CREATE TABLE messages (id TEXT);
             CREATE TABLE sessions (id TEXT);
             CREATE TABLE automations (id TEXT);
             CREATE TABLE automation_run_logs (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
    try {
      try {
        validateSchemaContract(db, file);
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(DatabaseSchemaMismatchError);
        const e = err as DatabaseSchemaMismatchError;
        expect(e.missingInvariants).toContain('projects.lint_command');
        expect(e.missingInvariants).toContain('projects.verify_command');
      }
    } finally {
      db.close();
    }
  });

  it('SYMPHONY_DB_FILE env var overrides the default path', () => {
    const file = tmpFile();
    files.push(file);
    process.env.SYMPHONY_DB_FILE = file;
    expect(resolveDatabasePath()).toBe(file);
    const svc = SymphonyDatabase.open();
    try {
      expect(svc.dbPath).toBe(file);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      svc.close();
    }
  });

  it('resolveDatabasePath default points into ~/.symphony when no override', () => {
    delete process.env.SYMPHONY_DB_FILE;
    const resolved = resolveDatabasePath();
    expect(resolved.endsWith(path.join('.symphony', 'symphony.db'))).toBe(true);
  });
});
