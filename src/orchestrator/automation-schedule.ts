/**
 * Phase 8D.1 — Automation schedule spec + next-run computation.
 *
 * Named-interval schedules (hourly / daily / weekly / monthly), ported
 * verbatim from emdash `AutomationsService.ts:101-158` (`computeNextRun`)
 * + `:81-99` (`validateSchedule`). Zero dependencies — pure date math over
 * the local-time JS `Date`. `now` is always injectable so the engine and
 * its tests share one deterministic clock.
 *
 * Raw 5-field cron strings are deliberately NOT supported in 8D.1 (emdash
 * itself has none; PLAN.md's "+ arbitrary cron" goes beyond the reference).
 * The spec is stored as JSON in the `automations.schedule` TEXT column via
 * {@link serializeSchedule} / {@link parseSchedule}.
 */

export type ScheduleType = 'hourly' | 'daily' | 'weekly' | 'monthly';

export type DayOfWeek = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

export interface AutomationSchedule {
  readonly type: ScheduleType;
  /** Hour of day, 0-23. Ignored for `hourly`. Defaults to 0. */
  readonly hour?: number;
  /** Minute of hour, 0-59. Defaults to 0. */
  readonly minute?: number;
  /** Day of week for `weekly`. Defaults to `mon`. */
  readonly dayOfWeek?: DayOfWeek;
  /** Day of month for `monthly`, 1-31 (clamped to month length). Defaults to 1. */
  readonly dayOfMonth?: number;
}

/** Sunday-indexed, matching JS `Date.getDay()`. */
const DAY_ORDER: readonly DayOfWeek[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const VALID_SCHEDULE_TYPES: readonly ScheduleType[] = ['hourly', 'daily', 'weekly', 'monthly'];

/** Thrown by {@link validateSchedule} / {@link parseSchedule} on a malformed spec. */
export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduleError';
  }
}

/**
 * Throw {@link InvalidScheduleError} if the schedule is malformed. Ported
 * from emdash `validateSchedule`, with a stricter check that hour/minute/
 * dayOfMonth are integers (emdash trusts its typed IPC; our spec arrives
 * from CLI flags + JSON on disk).
 */
export function validateSchedule(schedule: AutomationSchedule): void {
  if (!VALID_SCHEDULE_TYPES.includes(schedule.type)) {
    throw new InvalidScheduleError(`Invalid schedule type: ${String(schedule.type)}`);
  }
  if (schedule.hour !== undefined) {
    if (!Number.isInteger(schedule.hour) || schedule.hour < 0 || schedule.hour > 23) {
      throw new InvalidScheduleError(`Invalid hour: ${schedule.hour} (must be an integer 0-23)`);
    }
  }
  if (schedule.minute !== undefined) {
    if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) {
      throw new InvalidScheduleError(`Invalid minute: ${schedule.minute} (must be an integer 0-59)`);
    }
  }
  if (
    schedule.type === 'weekly' &&
    schedule.dayOfWeek !== undefined &&
    !DAY_ORDER.includes(schedule.dayOfWeek)
  ) {
    throw new InvalidScheduleError(`Invalid dayOfWeek: ${String(schedule.dayOfWeek)}`);
  }
  if (schedule.type === 'monthly') {
    const dom = schedule.dayOfMonth ?? 1;
    if (!Number.isInteger(dom) || dom < 1 || dom > 31) {
      throw new InvalidScheduleError(`Invalid dayOfMonth: ${dom} (must be an integer 1-31)`);
    }
  }
}

/**
 * Compute the next run time (ISO string) strictly AFTER `fromDate`.
 *
 * Verbatim port of emdash `computeNextRun`. Operates on local time via the
 * JS `Date` setters (no timezone library) — matches emdash's behavior and
 * the user's wall clock. The `next <= now` guards guarantee the result is
 * always in the future, so a tick that fires exactly on the boundary still
 * advances to the next period (no double-fire within one period).
 */
export function computeNextRun(schedule: AutomationSchedule, fromDate?: Date): string {
  const now = fromDate ?? new Date();
  const next = new Date(now);

  const hour = schedule.hour ?? 0;
  const minute = schedule.minute ?? 0;

  switch (schedule.type) {
    case 'hourly': {
      next.setMinutes(minute, 0, 0);
      if (next <= now) {
        next.setHours(next.getHours() + 1);
      }
      break;
    }
    case 'daily': {
      next.setHours(hour, minute, 0, 0);
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }
      break;
    }
    case 'weekly': {
      const targetDay = DAY_ORDER.indexOf(schedule.dayOfWeek ?? 'mon');
      const currentDay = next.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil < 0) daysUntil += 7;
      if (daysUntil === 0) {
        next.setHours(hour, minute, 0, 0);
        if (next <= now) {
          daysUntil = 7;
        }
      }
      if (daysUntil > 0) {
        next.setDate(next.getDate() + daysUntil);
      }
      next.setHours(hour, minute, 0, 0);
      break;
    }
    case 'monthly': {
      const desiredDom = schedule.dayOfMonth ?? 1;
      // Clamp to the last day of the current month (e.g. day-31 in Feb).
      const daysInCurrentMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      const targetDom = Math.min(desiredDom, daysInCurrentMonth);
      next.setDate(targetDom);
      next.setHours(hour, minute, 0, 0);
      if (next <= now) {
        // Audit M1 — collapse the day to 1 BEFORE bumping the month. emdash's
        // port bumps the month while `date` is still e.g. 31, which overflows
        // ("Feb 31" → Mar 3) and SKIPS the short month entirely (Jan-31 day-31
        // would jump to Mar 31, never Feb 28). Setting date=1 first keeps the
        // bump inside the intended next month.
        next.setDate(1);
        next.setMonth(next.getMonth() + 1);
        const daysInNextMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        next.setDate(Math.min(desiredDom, daysInNextMonth));
        next.setHours(hour, minute, 0, 0);
      }
      break;
    }
  }

  return next.toISOString();
}

/** Serialize a validated schedule to the TEXT column form (JSON). */
export function serializeSchedule(schedule: AutomationSchedule): string {
  validateSchedule(schedule);
  // Only persist the keys that are set, so the stored JSON is minimal and
  // round-trips cleanly (undefined keys are dropped by JSON.stringify).
  return JSON.stringify(schedule);
}

/**
 * Parse a schedule from the TEXT column. Throws {@link InvalidScheduleError}
 * on malformed JSON or an invalid spec — a stored automation must never
 * silently degrade to "no schedule".
 */
export function parseSchedule(raw: string): AutomationSchedule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new InvalidScheduleError(
      `schedule is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidScheduleError('schedule must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const schedule: AutomationSchedule = {
    type: obj['type'] as ScheduleType,
    ...(obj['hour'] !== undefined ? { hour: obj['hour'] as number } : {}),
    ...(obj['minute'] !== undefined ? { minute: obj['minute'] as number } : {}),
    ...(obj['dayOfWeek'] !== undefined ? { dayOfWeek: obj['dayOfWeek'] as DayOfWeek } : {}),
    ...(obj['dayOfMonth'] !== undefined ? { dayOfMonth: obj['dayOfMonth'] as number } : {}),
  };
  validateSchedule(schedule);
  return schedule;
}

/** Human-readable one-line description for the `automations list` CLI. */
export function describeSchedule(schedule: AutomationSchedule): string {
  const hh = String(schedule.hour ?? 0).padStart(2, '0');
  const mm = String(schedule.minute ?? 0).padStart(2, '0');
  switch (schedule.type) {
    case 'hourly':
      return `hourly at :${mm}`;
    case 'daily':
      return `daily at ${hh}:${mm}`;
    case 'weekly':
      return `weekly on ${schedule.dayOfWeek ?? 'mon'} at ${hh}:${mm}`;
    case 'monthly':
      return `monthly on day ${schedule.dayOfMonth ?? 1} at ${hh}:${mm}`;
  }
}
