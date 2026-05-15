import type { Database, Statement } from 'better-sqlite3';
import {
  AUDIT_KINDS,
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  type AuditAppendInput,
  type AuditEntry,
  type AuditKind,
  type AuditListFilter,
  type AuditSeverity,
  type AuditStore,
} from './audit-store.js';

interface AuditRow {
  id: number;
  ts: string;
  kind: string;
  severity: string;
  project_id: string | null;
  worker_id: string | null;
  task_id: string | null;
  tool_name: string | null;
  headline: string;
  payload: string;
}

const KINDS_SET: ReadonlySet<string> = new Set<string>(AUDIT_KINDS);

/**
 * Shared limit clamp — exported so the in-memory fallback store
 * (`createMemoryAuditStore`) stays behaviorally identical (audit M4:
 * the AuditLogger + RPC explicitly don't branch on the backing store,
 * so a divergent oracle hides bugs). Non-positive / non-finite → the
 * 200 default; otherwise floored + capped at 1000.
 */
export function clampAuditLimit(raw: number | undefined): number {
  if (raw === undefined) return AUDIT_LIST_DEFAULT_LIMIT;
  if (!Number.isFinite(raw) || raw <= 0) return AUDIT_LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), AUDIT_LIST_MAX_LIMIT);
}

/** Shared offset coercion — negative / non-finite → 0, else floored. */
export function clampAuditOffset(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

function clampLimit(raw: number | undefined): number {
  return clampAuditLimit(raw);
}

function decodePayload(raw: string): Readonly<Record<string, unknown>> {
  if (!raw) return Object.freeze({});
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.freeze(parsed as Record<string, unknown>);
    }
  } catch {
    // Corrupt JSON in the payload column — surface an empty object so
    // /log keeps rendering. The headline + structural columns survive.
  }
  return Object.freeze({});
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    ts: row.ts,
    kind: (KINDS_SET.has(row.kind) ? row.kind : 'error') as AuditKind,
    severity: row.severity as AuditSeverity,
    projectId: row.project_id,
    workerId: row.worker_id,
    taskId: row.task_id,
    toolName: row.tool_name,
    headline: row.headline,
    payload: decodePayload(row.payload),
  };
}

export class SqliteAuditStore implements AuditStore {
  private readonly stmts: {
    insert: Statement;
  };

  constructor(private readonly db: Database) {
    this.stmts = {
      insert: db.prepare(
        `INSERT INTO audit_log
           (ts, kind, severity, project_id, worker_id, task_id, tool_name, headline, payload)
         VALUES
           (@ts, @kind, @severity, @project_id, @worker_id, @task_id, @tool_name, @headline, @payload)`,
      ),
    };
  }

  append(input: AuditAppendInput): AuditEntry {
    const severity: AuditSeverity = input.severity ?? 'info';
    const payload: Record<string, unknown> = { ...(input.payload ?? {}) };
    const payloadJson = JSON.stringify(payload);
    const info = this.stmts.insert.run({
      ts: input.ts,
      kind: input.kind,
      severity,
      project_id: input.projectId ?? null,
      worker_id: input.workerId ?? null,
      task_id: input.taskId ?? null,
      tool_name: input.toolName ?? null,
      headline: input.headline,
      payload: payloadJson,
    });
    return {
      id: Number(info.lastInsertRowid),
      ts: input.ts,
      kind: input.kind,
      severity,
      projectId: input.projectId ?? null,
      workerId: input.workerId ?? null,
      taskId: input.taskId ?? null,
      toolName: input.toolName ?? null,
      headline: input.headline,
      payload: Object.freeze(payload),
    };
  }

  list(filter: AuditListFilter = {}): AuditEntry[] {
    const { sql, params } = buildListQuery(filter);
    const rows = this.db.prepare(sql).all(...params) as AuditRow[];
    return rows.map(rowToEntry);
  }

  count(filter: AuditListFilter = {}): number {
    const { sql, params } = buildCountQuery(filter);
    const row = this.db.prepare(sql).get(...params) as { c: number };
    return row.c;
  }
}

interface BuiltQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function buildWhere(filter: AuditListFilter): {
  clause: string;
  params: unknown[];
} {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId !== undefined) {
    parts.push('project_id = ?');
    params.push(filter.projectId);
  }
  if (filter.severity !== undefined) {
    parts.push('severity = ?');
    params.push(filter.severity);
  }
  if (filter.workerId !== undefined) {
    parts.push('worker_id = ?');
    params.push(filter.workerId);
  }
  if (filter.kinds !== undefined && filter.kinds.length > 0) {
    const placeholders = filter.kinds.map(() => '?').join(', ');
    parts.push(`kind IN (${placeholders})`);
    params.push(...filter.kinds);
  }
  if (filter.sinceTs !== undefined) {
    parts.push('ts >= ?');
    params.push(filter.sinceTs);
  }
  if (filter.untilTs !== undefined) {
    parts.push('ts <= ?');
    params.push(filter.untilTs);
  }
  const clause = parts.length === 0 ? '' : ` WHERE ${parts.join(' AND ')}`;
  return { clause, params };
}

function buildListQuery(filter: AuditListFilter): BuiltQuery {
  const { clause, params } = buildWhere(filter);
  const limit = clampLimit(filter.limit);
  const offset =
    filter.offset !== undefined && Number.isFinite(filter.offset) && filter.offset > 0
      ? Math.floor(filter.offset)
      : 0;
  const sql =
    `SELECT id, ts, kind, severity, project_id, worker_id, task_id, tool_name, headline, payload` +
    ` FROM audit_log${clause}` +
    ` ORDER BY ts DESC, id DESC` +
    ` LIMIT ? OFFSET ?`;
  return { sql, params: [...params, limit, offset] };
}

function buildCountQuery(filter: AuditListFilter): BuiltQuery {
  const { clause, params } = buildWhere(filter);
  return { sql: `SELECT COUNT(*) AS c FROM audit_log${clause}`, params };
}
