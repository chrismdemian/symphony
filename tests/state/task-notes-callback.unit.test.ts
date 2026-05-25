/**
 * Phase 5C — verify `onNotesAppended` fires for BOTH stores with the
 * same contract: post-update snapshot + a copy of the new note, only
 * on non-empty appends, swallows callback errors.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteTaskStore } from '../../src/state/sqlite-task-store.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import type { TaskNote, TaskSnapshot } from '../../src/state/types.js';

let tmpDir: string;
let db: SymphonyDatabase | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sym-5c-cb-'));
});

afterEach(() => {
  db?.close();
  db = undefined;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function openDb(): SymphonyDatabase {
  const dbPath = path.join(tmpDir, 'symphony.db');
  return SymphonyDatabase.open({ filePath: dbPath });
}

function insertProject(database: SymphonyDatabase): void {
  database.db
    .prepare(
      `INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run('p1', 'p1', tmpDir.replace(/\\/g, '/'), new Date().toISOString());
}

describe('TaskRegistry — onNotesAppended', () => {
  it('fires on a non-empty notes append', () => {
    const calls: Array<{ snapshot: TaskSnapshot; note: TaskNote }> = [];
    const reg = new TaskRegistry({
      now: () => Date.parse('2026-05-21T10:00:00.000Z'),
      idGenerator: () => 'tk-aa11bb22',
      onNotesAppended: (snapshot, note) => {
        calls.push({ snapshot, note });
      },
    });
    reg.create({ projectId: 'p1', description: 'do thing' });
    reg.update('tk-aa11bb22', { notes: 'progress: did X' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.note).toEqual({
      at: '2026-05-21T10:00:00.000Z',
      text: 'progress: did X',
    });
    expect(calls[0]!.snapshot.id).toBe('tk-aa11bb22');
    expect(calls[0]!.snapshot.notes).toHaveLength(1);
  });

  it('does NOT fire on a blank notes patch', () => {
    const calls: TaskNote[] = [];
    const reg = new TaskRegistry({
      onNotesAppended: (_snapshot, note) => {
        calls.push(note);
      },
    });
    reg.create({ projectId: 'p1', description: 'x' });
    const id = Array.from((reg as unknown as { records: Map<string, unknown> }).records.keys())[0]!;
    reg.update(id, { notes: '   ' });
    reg.update(id, { notes: '' });
    expect(calls).toHaveLength(0);
  });

  it('does NOT fire on a notes-omitted status patch', () => {
    const calls: TaskNote[] = [];
    const reg = new TaskRegistry({
      onNotesAppended: (_snapshot, note) => {
        calls.push(note);
      },
    });
    reg.create({ projectId: 'p1', description: 'x' });
    const id = Array.from((reg as unknown as { records: Map<string, unknown> }).records.keys())[0]!;
    reg.update(id, { status: 'in_progress' });
    expect(calls).toHaveLength(0);
  });

  it('swallows callback errors (must not poison update)', () => {
    const reg = new TaskRegistry({
      onNotesAppended: () => {
        throw new Error('boom');
      },
    });
    reg.create({ projectId: 'p1', description: 'x' });
    const id = Array.from((reg as unknown as { records: Map<string, unknown> }).records.keys())[0]!;
    expect(() => reg.update(id, { notes: 'still works' })).not.toThrow();
    expect(reg.snapshot(id)!.notes).toHaveLength(1);
  });

  it('fires once per append when status + notes change in one patch', () => {
    const noteCalls: TaskNote[] = [];
    const statusCalls: TaskSnapshot[] = [];
    const reg = new TaskRegistry({
      onTaskStatusChange: (snap) => statusCalls.push(snap),
      onNotesAppended: (_snap, note) => noteCalls.push(note),
    });
    reg.create({ projectId: 'p1', description: 'x' });
    const id = Array.from((reg as unknown as { records: Map<string, unknown> }).records.keys())[0]!;
    reg.update(id, { status: 'in_progress', notes: 'taking it' });
    expect(statusCalls).toHaveLength(1);
    expect(noteCalls).toHaveLength(1);
  });

  it('passes a defensive copy of the appended note (callback mutation does not leak)', () => {
    let captured: TaskNote | undefined;
    const reg = new TaskRegistry({
      onNotesAppended: (_snap, note) => {
        captured = note;
      },
    });
    reg.create({ projectId: 'p1', description: 'x' });
    const id = Array.from((reg as unknown as { records: Map<string, unknown> }).records.keys())[0]!;
    reg.update(id, { notes: 'hello' });
    // Mutating the captured object must not change the registry's note.
    (captured as { text: string }).text = 'tampered';
    const snap = reg.snapshot(id)!;
    expect(snap.notes[0]!.text).toBe('hello');
  });
});

describe('SqliteTaskStore — onNotesAppended', () => {
  it('fires on a non-empty notes append', async () => {
    db = openDb();
    insertProject(db);

    const calls: Array<{ snapshot: TaskSnapshot; note: TaskNote }> = [];
    const store = new SqliteTaskStore(db.db, {
      onNotesAppended: (snapshot, note) => {
        calls.push({ snapshot, note });
      },
    });
    const t = store.create({ projectId: 'p1', description: 'do thing' });
    store.update(t.id, { notes: 'progress: did X' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.note.text).toBe('progress: did X');
    expect(calls[0]!.snapshot.id).toBe(t.id);
    expect(calls[0]!.snapshot.notes).toHaveLength(1);
  });

  it('does NOT fire on a blank notes patch', async () => {
    db = openDb();
    insertProject(db);

    const calls: TaskNote[] = [];
    const store = new SqliteTaskStore(db.db, {
      onNotesAppended: (_snap, note) => calls.push(note),
    });
    const t = store.create({ projectId: 'p1', description: 'x' });
    store.update(t.id, { notes: '   ' });
    store.update(t.id, { notes: '' });
    expect(calls).toHaveLength(0);
  });

  it('swallows callback errors', async () => {
    db = openDb();
    insertProject(db);

    const store = new SqliteTaskStore(db.db, {
      onNotesAppended: () => {
        throw new Error('boom');
      },
    });
    const t = store.create({ projectId: 'p1', description: 'x' });
    expect(() => store.update(t.id, { notes: 'still works' })).not.toThrow();
    expect(store.snapshot(t.id)!.notes).toHaveLength(1);
  });

  it('fires after the status callback when both change in one patch', async () => {
    db = openDb();
    insertProject(db);

    const order: string[] = [];
    const store = new SqliteTaskStore(db.db, {
      onTaskStatusChange: () => order.push('status'),
      onNotesAppended: () => order.push('notes'),
    });
    const t = store.create({ projectId: 'p1', description: 'x' });
    store.update(t.id, { status: 'in_progress', notes: 'taking it' });
    expect(order).toEqual(['status', 'notes']);
  });

  // Verify that the callback receives the full post-update notes
  // array in the snapshot (so the disk mirror can be regenerated from
  // a single argument).
  it('snapshot.notes carries the full post-append notes list', async () => {
    db = openDb();
    insertProject(db);

    let lastSnapshot: TaskSnapshot | undefined;
    const store = new SqliteTaskStore(db.db, {
      onNotesAppended: (snap) => {
        lastSnapshot = snap;
      },
    });
    const t = store.create({ projectId: 'p1', description: 'x' });
    store.update(t.id, { notes: 'first' });
    store.update(t.id, { notes: 'second' });
    expect(lastSnapshot?.notes.map((n) => n.text)).toEqual(['first', 'second']);
  });
});
