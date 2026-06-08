import { describe, expect, it } from 'vitest';
import {
  computeNextRun,
  describeSchedule,
  InvalidScheduleError,
  parseSchedule,
  serializeSchedule,
  validateSchedule,
  type AutomationSchedule,
} from '../../src/orchestrator/automation-schedule.js';

/**
 * Phase 8D.1 — schedule spec + `computeNextRun`. Asserts on LOCAL-time Date
 * getters (computeNextRun operates on local time like emdash), so the tests
 * are timezone-agnostic — we never compare exact ISO strings.
 */

describe('computeNextRun', () => {
  it('hourly: advances to the next :MM, honoring minute only', () => {
    const from = new Date(2026, 5, 8, 14, 30, 15); // 14:30:15 local
    const next = new Date(computeNextRun({ type: 'hourly', minute: 45 }, from));
    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.getMinutes()).toBe(45);
    expect(next.getSeconds()).toBe(0);
    expect(next.getHours()).toBe(14); // 14:45 is still ahead of 14:30
  });

  it('hourly: rolls to the next hour when the minute already passed', () => {
    const from = new Date(2026, 5, 8, 14, 50, 0);
    const next = new Date(computeNextRun({ type: 'hourly', minute: 15 }, from));
    expect(next.getHours()).toBe(15);
    expect(next.getMinutes()).toBe(15);
  });

  it('daily: fires today at the time when it is ahead', () => {
    const from = new Date(2026, 5, 8, 6, 0, 0);
    const next = new Date(computeNextRun({ type: 'daily', hour: 9, minute: 30 }, from));
    expect(next.getDate()).toBe(8);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(30);
  });

  it('daily: rolls to tomorrow when the time already passed', () => {
    const from = new Date(2026, 5, 8, 10, 0, 0);
    const next = new Date(computeNextRun({ type: 'daily', hour: 9, minute: 0 }, from));
    expect(next.getDate()).toBe(9);
    expect(next.getHours()).toBe(9);
  });

  it('weekly: advances to the configured day of week', () => {
    // 2026-06-08 is a Monday.
    const from = new Date(2026, 5, 8, 12, 0, 0);
    const next = new Date(computeNextRun({ type: 'weekly', dayOfWeek: 'wed', hour: 8, minute: 0 }, from));
    expect(next.getDay()).toBe(3); // Wednesday
    expect(next.getDate()).toBe(10);
    expect(next.getHours()).toBe(8);
  });

  it('weekly: same-day-but-passed rolls a full week', () => {
    const from = new Date(2026, 5, 8, 20, 0, 0); // Monday 20:00
    const next = new Date(computeNextRun({ type: 'weekly', dayOfWeek: 'mon', hour: 9, minute: 0 }, from));
    expect(next.getDay()).toBe(1);
    expect(next.getDate()).toBe(15); // next Monday
  });

  it('monthly: clamps day-of-month to the month length', () => {
    // Ask for the 31st in February — clamp to the 28th (2026 is not a leap year).
    const from = new Date(2026, 1, 1, 0, 0, 0); // Feb 1 2026
    const next = new Date(computeNextRun({ type: 'monthly', dayOfMonth: 31, hour: 0, minute: 0 }, from));
    expect(next.getMonth()).toBe(1); // February
    expect(next.getDate()).toBe(28);
  });

  it('monthly: rolls to next month when the day already passed', () => {
    const from = new Date(2026, 5, 20, 12, 0, 0); // June 20
    const next = new Date(computeNextRun({ type: 'monthly', dayOfMonth: 1, hour: 9, minute: 0 }, from));
    expect(next.getMonth()).toBe(6); // July
    expect(next.getDate()).toBe(1);
  });

  it('monthly: day-31 on Jan 31 rolls to Feb 28 (no skipped month — audit M1)', () => {
    // Jan 31 2026, day-31 schedule already passed → must land on Feb 28,
    // NOT skip to Mar 31 (the emdash month-overflow bug).
    const from = new Date(2026, 0, 31, 12, 0, 0);
    const next = new Date(computeNextRun({ type: 'monthly', dayOfMonth: 31, hour: 0, minute: 0 }, from));
    expect(next.getMonth()).toBe(1); // February, not March
    expect(next.getDate()).toBe(28);
  });

  it('always returns a time strictly after `from`', () => {
    const from = new Date(2026, 5, 8, 9, 0, 0);
    for (const schedule of [
      { type: 'hourly', minute: 0 },
      { type: 'daily', hour: 9, minute: 0 },
      { type: 'weekly', dayOfWeek: 'mon', hour: 9, minute: 0 },
      { type: 'monthly', dayOfMonth: 8, hour: 9, minute: 0 },
    ] as AutomationSchedule[]) {
      const next = new Date(computeNextRun(schedule, from));
      expect(next.getTime()).toBeGreaterThan(from.getTime());
    }
  });
});

describe('validateSchedule', () => {
  it('rejects an unknown type', () => {
    expect(() => validateSchedule({ type: 'yearly' as 'daily' })).toThrow(InvalidScheduleError);
  });
  it('rejects out-of-range hour/minute and non-integers', () => {
    expect(() => validateSchedule({ type: 'daily', hour: 24 })).toThrow(InvalidScheduleError);
    expect(() => validateSchedule({ type: 'daily', minute: -1 })).toThrow(InvalidScheduleError);
    expect(() => validateSchedule({ type: 'daily', hour: 9.5 })).toThrow(InvalidScheduleError);
  });
  it('rejects an invalid dayOfWeek and dayOfMonth', () => {
    expect(() => validateSchedule({ type: 'weekly', dayOfWeek: 'xyz' as 'mon' })).toThrow(
      InvalidScheduleError,
    );
    expect(() => validateSchedule({ type: 'monthly', dayOfMonth: 32 })).toThrow(InvalidScheduleError);
  });
});

describe('serialize/parse round-trip', () => {
  it('round-trips every shape', () => {
    const shapes: AutomationSchedule[] = [
      { type: 'hourly', minute: 5 },
      { type: 'daily', hour: 9, minute: 30 },
      { type: 'weekly', dayOfWeek: 'fri', hour: 17, minute: 0 },
      { type: 'monthly', dayOfMonth: 15, hour: 6, minute: 0 },
    ];
    for (const s of shapes) {
      expect(parseSchedule(serializeSchedule(s))).toEqual(s);
    }
  });
  it('throws on malformed JSON and on an invalid spec', () => {
    expect(() => parseSchedule('{not json')).toThrow(InvalidScheduleError);
    expect(() => parseSchedule('[]')).toThrow(InvalidScheduleError);
    expect(() => parseSchedule('{"type":"weekly","dayOfWeek":"funday"}')).toThrow(
      InvalidScheduleError,
    );
  });
});

describe('describeSchedule', () => {
  it('renders a human one-liner per type', () => {
    expect(describeSchedule({ type: 'hourly', minute: 5 })).toBe('hourly at :05');
    expect(describeSchedule({ type: 'daily', hour: 9, minute: 0 })).toBe('daily at 09:00');
    expect(describeSchedule({ type: 'weekly', dayOfWeek: 'mon', hour: 8, minute: 30 })).toBe(
      'weekly on mon at 08:30',
    );
    expect(describeSchedule({ type: 'monthly', dayOfMonth: 1, hour: 0, minute: 0 })).toBe(
      'monthly on day 1 at 00:00',
    );
  });
});
