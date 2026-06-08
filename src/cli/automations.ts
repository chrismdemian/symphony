import { SymphonyDatabase } from '../state/db.js';
import { resolveDatabasePath } from '../state/path.js';
import { SqliteAutomationStore } from '../state/sqlite-automation-store.js';
import { SqliteProjectStore } from '../state/sqlite-project-store.js';
import type { AutomationStore, AutomationRecord } from '../state/automation-store.js';
import {
  describeSchedule,
  InvalidScheduleError,
  validateSchedule,
  type AutomationSchedule,
  type DayOfWeek,
  type ScheduleType,
} from '../orchestrator/automation-schedule.js';

/**
 * Phase 8D.1 — `symphony automations …` CLI runners.
 *
 * Each runner opens the full SQLite DB (migrations + schema contract),
 * mutates the `automations` table, prints a human line to stderr, and
 * returns an exitCode. `list` supports `--json` to stdout. CRUD works
 * without a running session; an automation fires only while `symphony
 * start` is running (its scheduler ticks + the launcher delivers to
 * Maestro). `run` forces it due so the active session picks it up next tick.
 */

export interface AutomationsCliResult {
  readonly exitCode: number;
}

interface BaseOpts {
  readonly dbFilePath?: string;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

const SCHEDULE_TYPES: readonly ScheduleType[] = ['hourly', 'daily', 'weekly', 'monthly'];
const DAYS: readonly DayOfWeek[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Thrown when an automation target is rejected at registration. */
export class AutomationTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationTargetError';
  }
}

/**
 * Phase 8D.1 — registration-time rejection of host-browser-control targets.
 * 8D.1 automations are prompt-only (no `--target-plugin` flag), so this never
 * throws today; the check exists so 8D.2's trigger/target config flows
 * through one rejection point with a clear, actionable message. The
 * load-bearing RUNTIME guard is the injector's `automationContext` flag
 * (`capabilities.ts` denies `requires-host-browser-control` while true).
 */
export function assertNoAutomationHostBrowserTarget(
  targetPlugin: string | undefined,
  hostBrowserPluginIds: ReadonlySet<string>,
): void {
  if (targetPlugin !== undefined && hostBrowserPluginIds.has(targetPlugin)) {
    throw new AutomationTargetError(
      `Plugin '${targetPlugin}' requires host-browser-control and cannot be an automation ` +
        `target — it needs per-action confirmation and automations run unattended. ` +
        `Use Browserbase for cron-style authenticated browser tasks.`,
    );
  }
}

function writer(stream: NodeJS.WritableStream | undefined, fallback: NodeJS.WritableStream) {
  const s = stream ?? fallback;
  return (line: string): void => {
    s.write(line.endsWith('\n') ? line : `${line}\n`);
  };
}

function withDb<T>(dbFilePath: string | undefined, fn: (db: SymphonyDatabase) => T): T {
  const db = SymphonyDatabase.open({ filePath: dbFilePath ?? resolveDatabasePath() });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Parse `--at HH:MM` into {hour, minute}. Throws on a malformed value. */
function parseAt(at: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (m === null) {
    throw new InvalidScheduleError(`--at must be HH:MM (got '${at}')`);
  }
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export interface BuildScheduleInput {
  readonly every: string;
  readonly at?: string;
  readonly on?: string;
  readonly day?: string;
}

/** Assemble + validate an {@link AutomationSchedule} from CLI flags. */
export function buildScheduleFromFlags(input: BuildScheduleInput): AutomationSchedule {
  const type = input.every as ScheduleType;
  if (!SCHEDULE_TYPES.includes(type)) {
    throw new InvalidScheduleError(
      `--every must be one of ${SCHEDULE_TYPES.join(' | ')} (got '${input.every}')`,
    );
  }
  const time = input.at !== undefined ? parseAt(input.at) : undefined;
  const schedule: AutomationSchedule = {
    type,
    // Hourly ignores the hour component; everything else honors --at.
    ...(time !== undefined && type !== 'hourly' ? { hour: time.hour } : {}),
    ...(time !== undefined ? { minute: time.minute } : {}),
    ...(type === 'weekly' && input.on !== undefined
      ? { dayOfWeek: input.on.toLowerCase() as DayOfWeek }
      : {}),
    ...(type === 'monthly' && input.day !== undefined ? { dayOfMonth: Number(input.day) } : {}),
  };
  if (type === 'weekly' && schedule.dayOfWeek !== undefined && !DAYS.includes(schedule.dayOfWeek)) {
    throw new InvalidScheduleError(`--on must be one of ${DAYS.join(' | ')} (got '${input.on}')`);
  }
  validateSchedule(schedule);
  return schedule;
}

export interface RunAutomationsAddOptions extends BaseOpts {
  readonly name: string;
  readonly prompt: string;
  readonly every: string;
  readonly at?: string;
  readonly on?: string;
  readonly day?: string;
  readonly project?: string;
  readonly disabled?: boolean;
}

export function runAutomationsAdd(opts: RunAutomationsAddOptions): AutomationsCliResult {
  const out = writer(opts.stderr, process.stderr);
  if (opts.name.trim().length === 0) {
    out('error: automation name must not be empty');
    return { exitCode: 1 };
  }
  if (opts.prompt.trim().length === 0) {
    out('error: --prompt must not be empty');
    return { exitCode: 1 };
  }
  let schedule: AutomationSchedule;
  try {
    schedule = buildScheduleFromFlags(opts);
  } catch (err) {
    out(`error: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1 };
  }
  // Phase 8D.1 — no plugin-target field yet; the guard is a no-op scaffold.
  try {
    assertNoAutomationHostBrowserTarget(undefined, new Set());
  } catch (err) {
    out(`error: ${err instanceof Error ? err.message : String(err)}`);
    return { exitCode: 1 };
  }
  return withDb(opts.dbFilePath, (db): AutomationsCliResult => {
    let projectId: string | null = null;
    if (opts.project !== undefined) {
      const project = new SqliteProjectStore(db.db).get(opts.project);
      if (project === undefined) {
        out(`error: unknown project '${opts.project}'`);
        return { exitCode: 1 };
      }
      projectId = project.id;
    }
    const store: AutomationStore = new SqliteAutomationStore(db.db);
    const record = store.create({
      name: opts.name,
      prompt: opts.prompt,
      schedule,
      projectId,
      enabled: opts.disabled !== true,
    });
    out(
      `added automation '${record.name}' (${record.id}) — ${describeSchedule(schedule)}` +
        `${record.enabled ? '' : ' [disabled]'}; next run ${record.nextRunAt ?? '(none)'}`,
    );
    return { exitCode: 0 };
  });
}

export interface RunAutomationsListOptions extends BaseOpts {
  readonly json?: boolean;
}

export function runAutomationsList(opts: RunAutomationsListOptions): AutomationsCliResult {
  const out = writer(opts.stderr, process.stderr);
  const stdout = writer(opts.stdout, process.stdout);
  return withDb(opts.dbFilePath, (db): AutomationsCliResult => {
    const records = new SqliteAutomationStore(db.db).list();
    if (opts.json === true) {
      stdout(JSON.stringify(records.map(toJson), null, 2));
      return { exitCode: 0 };
    }
    if (records.length === 0) {
      out('No automations defined. Add one with `symphony automations add`.');
      return { exitCode: 0 };
    }
    for (const r of records) {
      const sched = r.schedule !== null ? describeSchedule(r.schedule) : '(no schedule)';
      const flags = [r.enabled ? null : 'disabled', r.inFlight ? 'running' : null]
        .filter((x): x is string => x !== null)
        .join(', ');
      out(
        `${r.id}  ${r.name}  —  ${sched}` +
          `${flags.length > 0 ? ` [${flags}]` : ''}` +
          `  next ${r.nextRunAt ?? '(none)'}  runs ${r.runCount}`,
      );
    }
    return { exitCode: 0 };
  });
}

export interface RunAutomationsByIdOptions extends BaseOpts {
  readonly id: string;
}

export function runAutomationsRemove(opts: RunAutomationsByIdOptions): AutomationsCliResult {
  const out = writer(opts.stderr, process.stderr);
  return withDb(opts.dbFilePath, (db): AutomationsCliResult => {
    const removed = new SqliteAutomationStore(db.db).delete(opts.id);
    if (!removed) {
      out(`error: no automation with id '${opts.id}'`);
      return { exitCode: 1 };
    }
    out(`removed automation '${opts.id}'`);
    return { exitCode: 0 };
  });
}

export function runAutomationsSetEnabled(
  opts: RunAutomationsByIdOptions & { enabled: boolean },
): AutomationsCliResult {
  const out = writer(opts.stderr, process.stderr);
  return withDb(opts.dbFilePath, (db): AutomationsCliResult => {
    const ok = new SqliteAutomationStore(db.db).setEnabled(opts.id, opts.enabled);
    if (!ok) {
      out(`error: no automation with id '${opts.id}'`);
      return { exitCode: 1 };
    }
    out(`${opts.enabled ? 'enabled' : 'disabled'} automation '${opts.id}'`);
    return { exitCode: 0 };
  });
}

export interface RunAutomationsRunOptions extends RunAutomationsByIdOptions {
  /** Injected clock (tests). Defaults to the real now. */
  readonly nowIso?: string;
}

export function runAutomationsRun(opts: RunAutomationsRunOptions): AutomationsCliResult {
  const out = writer(opts.stderr, process.stderr);
  const nowIso = opts.nowIso ?? new Date().toISOString();
  return withDb(opts.dbFilePath, (db): AutomationsCliResult => {
    const store = new SqliteAutomationStore(db.db);
    const record = store.get(opts.id);
    if (record === undefined) {
      out(`error: no automation with id '${opts.id}'`);
      return { exitCode: 1 };
    }
    if (!record.enabled) {
      out(`error: automation '${opts.id}' is disabled — enable it first`);
      return { exitCode: 1 };
    }
    store.forceDue(opts.id, nowIso);
    out(
      `automation '${opts.id}' marked due — it fires on the next tick of a running ` +
        `\`symphony start\` session`,
    );
    return { exitCode: 0 };
  });
}

function toJson(r: AutomationRecord): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    projectId: r.projectId,
    schedule: r.schedule,
    enabled: r.enabled,
    inFlight: r.inFlight,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    lastRunResult: r.lastRunResult,
    runCount: r.runCount,
    createdAt: r.createdAt,
  };
}
