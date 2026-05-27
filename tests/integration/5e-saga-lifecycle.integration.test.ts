/**
 * Phase 5E integration — saga lifecycle through real SQLite + real
 * stores + real rollup listener. Mirrors the unit-level rollup chain
 * exercised in `saga-tools.unit.test.ts` but pinned to the SQLite path
 * + the schema validator so the saga tables are guaranteed migrated.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import { makeCreateSagaTool } from '../../src/orchestrator/tools/create-saga.js';
import { makeUpdateSagaTool } from '../../src/orchestrator/tools/update-saga.js';
import { makeGetSagaTool } from '../../src/orchestrator/tools/get-saga.js';
import { makeListSagasTool } from '../../src/orchestrator/tools/list-sagas.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SqliteSagaStore } from '../../src/state/sqlite-saga-store.js';
import { SqliteTaskStore } from '../../src/state/sqlite-task-store.js';
import { createSagaRollupListener } from '../../src/state/saga-rollup.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';

function ctx(): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act' };
}

let sandbox: string;
let dbPath: string;
let db: SymphonyDatabase;
let projects: SqliteProjectStore;
let tasks: SqliteTaskStore;
let sagas: SqliteSagaStore;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'symphony-5e-'));
  dbPath = path.join(sandbox, 'symphony.db');
  db = SymphonyDatabase.open({ filePath: dbPath });
  projects = new SqliteProjectStore(db.db);
  sagas = new SqliteSagaStore(db.db, { projectStore: projects });
  tasks = new SqliteTaskStore(db.db, {
    onTaskStatusChange: createSagaRollupListener({ sagaStore: sagas }),
  });
  projects.register({ id: 'p-a', name: 'projA', path: '/tmp/a', createdAt: '' });
  projects.register({ id: 'p-b', name: 'projB', path: '/tmp/b', createdAt: '' });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('saga lifecycle — SQLite-backed', () => {
  it('create_saga writes saga + member rows atomically', async () => {
    const tool = makeCreateSagaTool({
      sagaStore: sagas,
      taskStore: tasks,
      projectStore: projects,
    });
    const res = await tool.handler(
      {
        description: 'ship the cross-project feature',
        members: [
          { project: 'projA', task_description: 'A side', priority: undefined },
          { project: 'projB', task_description: 'B side', priority: undefined },
        ],
      },
      ctx(),
    );
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent! as {
      saga: { id: string };
      members: { taskId: string; projectId: string }[];
    };
    const sagaId = sc.saga.id;

    // Saga row landed in SQLite.
    const sagaRow = sagas.get(sagaId);
    expect(sagaRow?.status).toBe('pending');
    // Member rows landed and reference real tasks.
    const members = sagas.listMembers(sagaId);
    expect(members.length).toBe(2);
    for (const m of members) {
      const t = tasks.get(m.taskId);
      expect(t?.status).toBe('pending');
      expect(['p-a', 'p-b']).toContain(t?.projectId);
    }
  });

  it('rollup transitions saga pending → in_progress → completed via member updates', async () => {
    const create = makeCreateSagaTool({
      sagaStore: sagas,
      taskStore: tasks,
      projectStore: projects,
    });
    const created = await create.handler(
      {
        description: 'cross',
        members: [
          { project: 'projA', task_description: 'a', priority: undefined },
          { project: 'projB', task_description: 'b', priority: undefined },
        ],
      },
      ctx(),
    );
    const sc = created.structuredContent! as {
      saga: { id: string };
      members: { taskId: string }[];
    };
    const sagaId = sc.saga.id;
    const [tA, tB] = sc.members;

    expect(sagas.get(sagaId)?.status).toBe('pending');

    tasks.update(tA!.taskId, { status: 'in_progress' });
    expect(sagas.get(sagaId)?.status).toBe('in_progress');

    tasks.update(tA!.taskId, { status: 'completed' });
    // One member still pending → saga stays in_progress.
    expect(sagas.get(sagaId)?.status).toBe('in_progress');

    tasks.update(tB!.taskId, { status: 'in_progress' });
    tasks.update(tB!.taskId, { status: 'completed' });
    expect(sagas.get(sagaId)?.status).toBe('completed');
    // completedAt stamped.
    expect(sagas.get(sagaId)?.completedAt).toBeTruthy();
  });

  it('saga rolls up to failed on any member failure (sticky)', async () => {
    const create = makeCreateSagaTool({
      sagaStore: sagas,
      taskStore: tasks,
      projectStore: projects,
    });
    const created = await create.handler(
      {
        description: 'cross-fail',
        members: [
          { project: 'projA', task_description: 'a', priority: undefined },
          { project: 'projB', task_description: 'b', priority: undefined },
        ],
      },
      ctx(),
    );
    const sc = created.structuredContent! as {
      saga: { id: string };
      members: { taskId: string }[];
    };
    const sagaId = sc.saga.id;
    const [tA, tB] = sc.members;

    tasks.update(tA!.taskId, { status: 'in_progress' });
    tasks.update(tA!.taskId, { status: 'failed' });
    expect(sagas.get(sagaId)?.status).toBe('failed');

    // Subsequent member completion does NOT recover a failed saga.
    tasks.update(tB!.taskId, { status: 'in_progress' });
    tasks.update(tB!.taskId, { status: 'completed' });
    expect(sagas.get(sagaId)?.status).toBe('failed');
  });

  it('update_saga(status="cancelled") works on a pending saga (explicit user pivot)', async () => {
    const create = makeCreateSagaTool({
      sagaStore: sagas,
      taskStore: tasks,
      projectStore: projects,
    });
    const update = makeUpdateSagaTool({ sagaStore: sagas });
    const created = await create.handler(
      {
        description: 'will be cancelled',
        members: [
          { project: 'projA', task_description: 'a', priority: undefined },
          { project: 'projB', task_description: 'b', priority: undefined },
        ],
      },
      ctx(),
    );
    const sc = created.structuredContent! as { saga: { id: string } };
    const cancelRes = await update.handler(
      { saga_id: sc.saga.id, status: 'cancelled', notes: undefined, result: undefined },
      ctx(),
    );
    expect(cancelRes.isError).toBeFalsy();
    expect(sagas.get(sc.saga.id)?.status).toBe('cancelled');
  });

  it('get_saga + list_sagas reflect rollup state after lifecycle transitions', async () => {
    const create = makeCreateSagaTool({
      sagaStore: sagas,
      taskStore: tasks,
      projectStore: projects,
    });
    const get = makeGetSagaTool({ sagaStore: sagas });
    const list = makeListSagasTool({ sagaStore: sagas, projectStore: projects });
    const created = await create.handler(
      {
        description: 'reads',
        members: [
          { project: 'projA', task_description: 'a', priority: undefined },
          { project: 'projB', task_description: 'b', priority: undefined },
        ],
      },
      ctx(),
    );
    const sc = created.structuredContent! as {
      saga: { id: string };
      members: { taskId: string }[];
    };
    tasks.update(sc.members[0]!.taskId, { status: 'in_progress' });

    const got = await get.handler({ saga_id: sc.saga.id }, ctx());
    expect(got.isError).toBeFalsy();
    const gotSc = got.structuredContent! as {
      saga: { status: string; members: { status: string }[] };
    };
    expect(gotSc.saga.status).toBe('in_progress');
    // Member statuses match.
    expect(gotSc.saga.members.map((m) => m.status).sort()).toEqual([
      'in_progress',
      'pending',
    ]);

    // list with project filter — saga is included in BOTH projA and projB.
    const listA = await list.handler(
      { project: 'projA', status: undefined, limit: undefined },
      ctx(),
    );
    const scA = listA.structuredContent! as { sagas: { id: string }[] };
    expect(scA.sagas.map((s) => s.id)).toContain(sc.saga.id);
    const listB = await list.handler(
      { project: 'projB', status: undefined, limit: undefined },
      ctx(),
    );
    const scB = listB.structuredContent! as { sagas: { id: string }[] };
    expect(scB.sagas.map((s) => s.id)).toContain(sc.saga.id);
  });

  it('schema validator: db open succeeds with sagas + saga_members tables', () => {
    // Indirectly asserted by every test above (db opens cleanly); add an
    // explicit check the tables exist in the SQLite schema introspection.
    const tables = db.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('sagas');
    expect(names).toContain('saga_members');
  });
});
