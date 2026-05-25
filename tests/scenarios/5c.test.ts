/**
 * Phase 5C production scenario — exercises the `task_notes` MCP tool +
 * the disk mirror end-to-end against real fs / real SQLite / real
 * registered project. See `tests/scenarios/5c.md` for the
 * Given/When/Then.
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import { makeListTasksTool } from '../../src/orchestrator/tools/list-tasks.js';
import { makeTaskNotesTool } from '../../src/orchestrator/tools/task-notes.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SqliteTaskStore } from '../../src/state/sqlite-task-store.js';
import { createTaskNotesMirrorQueue } from '../../src/state/task-notes-mirror-queue.js';
import type { TaskSnapshot } from '../../src/state/types.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function initRepo(repoPath: string): Promise<void> {
  mkdirSync(repoPath, { recursive: true });
  await git(repoPath, 'init', '--initial-branch=main');
  await git(repoPath, 'config', 'user.email', 'test@example.com');
  await git(repoPath, 'config', 'user.name', 'Symphony Test');
  await git(repoPath, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(repoPath, 'README.md'), '# demo\n');
  await git(repoPath, 'add', '.');
  await git(repoPath, 'commit', '-m', 'init');
}

const CTX = { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act' as const };

describe('Phase 5C scenario — task_notes externalization (real fs + real sqlite + real git)', () => {
  let sandbox: string;
  let projectRoot: string;
  let dbPath: string;
  let db: SymphonyDatabase | undefined;

  beforeEach(async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'sym-5c-scn-'));
    projectRoot = path.join(sandbox, 'proj');
    dbPath = path.join(sandbox, 'symphony.db');
    await initRepo(projectRoot);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  it('Given+When+Then — full task_notes + mirror + list_tasks round-trip', async () => {
    // ── Given ──────────────────────────────────────────────────────────
    db = SymphonyDatabase.open({ filePath: dbPath });
    const projectStore = new SqliteProjectStore(db.db);
    const projRecord = projectStore.register({
      id: 'demo',
      name: 'demo',
      path: projectRoot,
      createdAt: new Date().toISOString(),
    });

    // Same wiring as `server.ts:taskNotesOnAppend` — uses the per-task
    // mirror serializer so back-to-back appends settle in order. The
    // scenario tracks per-task mirror tails so it can `await` the
    // chain instead of fixed-sleep polling — parallel CI load
    // otherwise races the final rename.
    const mirrorQueue = createTaskNotesMirrorQueue();
    const mirrorTails = new Map<string, Promise<unknown>>();
    const taskStore = new SqliteTaskStore(db.db, {
      onNotesAppended: (snapshot: TaskSnapshot) => {
        const proj = projectStore.get(snapshot.projectId);
        const projectPath = proj?.path ?? null;
        const tail = mirrorQueue
          .enqueue({
            projectPath,
            taskId: snapshot.id,
            notes: snapshot.notes,
          })
          .catch(() => undefined);
        mirrorTails.set(snapshot.id, tail);
      },
    });

    const taskA = taskStore.create({ projectId: projRecord.id, description: 'task A' });
    const taskB = taskStore.create({ projectId: projRecord.id, description: 'task B' });
    const taskC = taskStore.create({ projectId: projRecord.id, description: 'task C (no notes)' });

    const taskNotesTool = makeTaskNotesTool({ taskStore, projectStore });
    const listTasksTool = makeListTasksTool({ taskStore, projectStore });

    // ── When 1–3: three appends across two tasks ─────────────────────
    const appends: Array<{ task_id: string; text: string }> = [
      { task_id: taskA.id, text: 'started work' },
      { task_id: taskA.id, text: 'found the cause' },
      { task_id: taskB.id, text: 'ready to ship' },
    ];
    for (const a of appends) {
      const res = await taskNotesTool.handler(
        {
          action: 'append',
          task_id: a.task_id,
          text: a.text,
          since: undefined,
          limit: undefined,
          project: undefined,
        },
        CTX,
      );
      expect(res.isError).toBeFalsy();
    }

    // ── When 4: let the mirror writer flush ──────────────────────────
    await Promise.all(mirrorTails.values());

    // ── Then 1: mirror files appear with expected content ───────────
    const mirrorA = path.resolve(projectRoot, '.symphony', 'tasks', taskA.id, 'notes.md');
    const mirrorB = path.resolve(projectRoot, '.symphony', 'tasks', taskB.id, 'notes.md');
    const mirrorC = path.resolve(projectRoot, '.symphony', 'tasks', taskC.id, 'notes.md');

    expect(existsSync(mirrorA)).toBe(true);
    expect(existsSync(mirrorB)).toBe(true);
    expect(existsSync(mirrorC)).toBe(false);

    const bodyA = readFileSync(mirrorA, 'utf8');
    expect(bodyA).toContain('AUTOGENERATED by Symphony');
    expect(bodyA).toContain('started work');
    expect(bodyA).toContain('found the cause');
    // The two section headers are present (timestamps may differ by ms).
    expect((bodyA.match(/^## \d{4}-\d{2}-\d{2}/gm) ?? []).length).toBe(2);

    const bodyB = readFileSync(mirrorB, 'utf8');
    expect(bodyB).toContain('ready to ship');
    expect((bodyB.match(/^## \d{4}-\d{2}-\d{2}/gm) ?? []).length).toBe(1);

    // ── When 5: task_notes read for task A ───────────────────────────
    const readRes = await taskNotesTool.handler(
      {
        action: 'read',
        task_id: taskA.id,
        text: undefined,
        since: undefined,
        limit: undefined,
        project: undefined,
      },
      CTX,
    );
    expect(readRes.isError).toBeFalsy();
    const readText = readRes.content.map((c) => c.text).join('\n');
    expect(readText).toContain('started work');
    expect(readText).toContain('found the cause');
    const readSc = readRes.structuredContent as {
      total: number;
      returned: number;
      truncated: boolean;
    };
    expect(readSc.total).toBe(2);
    expect(readSc.returned).toBe(2);
    expect(readSc.truncated).toBe(false);

    // ── When 6: task_notes list — only tasks with notes ──────────────
    const listNotesRes = await taskNotesTool.handler(
      {
        action: 'list',
        task_id: undefined,
        text: undefined,
        since: undefined,
        limit: undefined,
        project: undefined,
      },
      CTX,
    );
    expect(listNotesRes.isError).toBeFalsy();
    const listNotesSc = listNotesRes.structuredContent as {
      total: number;
      summaries: Array<{ taskId: string; count: number; firstAt: string; lastAt: string }>;
    };
    expect(listNotesSc.total).toBe(2);
    const summaryIds = new Set(listNotesSc.summaries.map((s) => s.taskId));
    expect(summaryIds.has(taskA.id)).toBe(true);
    expect(summaryIds.has(taskB.id)).toBe(true);
    expect(summaryIds.has(taskC.id)).toBe(false);
    const summaryA = listNotesSc.summaries.find((s) => s.taskId === taskA.id)!;
    expect(summaryA.count).toBe(2);
    expect(summaryA.firstAt).toBeDefined();
    expect(summaryA.lastAt).toBeDefined();

    // ── When 7: list_tasks default — notes stripped ─────────────────
    const listDefault = await listTasksTool.handler(
      {
        project: undefined,
        status: undefined,
        limit: undefined,
        ready_only: undefined,
        include_notes: undefined,
      },
      CTX,
    );
    expect(listDefault.isError).toBeFalsy();
    const listDefaultSc = listDefault.structuredContent as {
      notesIncluded: boolean;
      tasks: Array<{ id: string; notes?: unknown }>;
    };
    expect(listDefaultSc.notesIncluded).toBe(false);
    expect(listDefaultSc.tasks).toHaveLength(3);
    for (const t of listDefaultSc.tasks) {
      expect(t.notes).toBeUndefined();
      expect('notes' in t).toBe(false);
    }

    // ── When 8: list_tasks include_notes:true — notes present ───────
    const listFull = await listTasksTool.handler(
      {
        project: undefined,
        status: undefined,
        limit: undefined,
        ready_only: undefined,
        include_notes: true,
      },
      CTX,
    );
    const listFullSc = listFull.structuredContent as {
      notesIncluded: boolean;
      tasks: Array<{ id: string; notes: Array<{ at: string; text: string }> }>;
    };
    expect(listFullSc.notesIncluded).toBe(true);
    expect(listFullSc.tasks).toHaveLength(3);
    const taskAFull = listFullSc.tasks.find((t) => t.id === taskA.id)!;
    expect(taskAFull.notes.map((n) => n.text)).toEqual(['started work', 'found the cause']);
    const taskBFull = listFullSc.tasks.find((t) => t.id === taskB.id)!;
    expect(taskBFull.notes.map((n) => n.text)).toEqual(['ready to ship']);
    const taskCFull = listFullSc.tasks.find((t) => t.id === taskC.id)!;
    expect(taskCFull.notes).toEqual([]);
  });
});
