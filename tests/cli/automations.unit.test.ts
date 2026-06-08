import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertNoAutomationHostBrowserTarget,
  AutomationTargetError,
  runAutomationsAdd,
  runAutomationsList,
  runAutomationsRemove,
  runAutomationsRun,
  runAutomationsSetEnabled,
} from '../../src/cli/automations.js';
import { buildScheduleFromFlags } from '../../src/orchestrator/automation-schedule.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteAutomationStore } from '../../src/state/sqlite-automation-store.js';

/**
 * Phase 8D.1 — `symphony automations …` CLI runners against a real on-disk
 * SQLite DB (migrations + schema contract exercised).
 */

class Capture {
  lines: string[] = [];
  write(chunk: string): boolean {
    this.lines.push(chunk);
    return true;
  }
  text(): string {
    return this.lines.join('');
  }
}

describe('automations CLI', () => {
  let dir: string;
  let dbFilePath: string;
  let out: Capture;
  let err: Capture;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sym-auto-cli-'));
    dbFilePath = path.join(dir, 'symphony.db');
    out = new Capture();
    err = new Capture();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base = () => ({
    dbFilePath,
    stdout: out as unknown as NodeJS.WritableStream,
    stderr: err as unknown as NodeJS.WritableStream,
  });

  it('add → list → run → disable → enable → remove round-trip', () => {
    const add = runAutomationsAdd({
      ...base(),
      name: 'nightly',
      prompt: 'run the test suite and report failures',
      every: 'daily',
      at: '02:00',
    });
    expect(add.exitCode).toBe(0);
    expect(err.text()).toContain("added automation 'nightly'");

    // Read the id back from the store.
    const db = SymphonyDatabase.open({ filePath: dbFilePath });
    const id = new SqliteAutomationStore(db.db).list()[0]!.id;
    db.close();

    out.lines = [];
    const listJson = runAutomationsList({ ...base(), json: true });
    expect(listJson.exitCode).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('nightly');
    expect(parsed[0].schedule).toEqual({ type: 'daily', hour: 2, minute: 0 });

    expect(runAutomationsRun({ ...base(), id }).exitCode).toBe(0);
    expect(runAutomationsSetEnabled({ ...base(), id, enabled: false }).exitCode).toBe(0);
    // run on a disabled automation is rejected.
    expect(runAutomationsRun({ ...base(), id }).exitCode).toBe(1);
    expect(runAutomationsSetEnabled({ ...base(), id, enabled: true }).exitCode).toBe(0);
    expect(runAutomationsRemove({ ...base(), id }).exitCode).toBe(0);
    expect(runAutomationsRemove({ ...base(), id }).exitCode).toBe(1); // already gone
  });

  it('rejects a malformed schedule and an empty prompt', () => {
    expect(
      runAutomationsAdd({ ...base(), name: 'x', prompt: 'p', every: 'yearly' }).exitCode,
    ).toBe(1);
    expect(
      runAutomationsAdd({ ...base(), name: 'x', prompt: '   ', every: 'daily', at: '09:00' }).exitCode,
    ).toBe(1);
    expect(
      runAutomationsAdd({ ...base(), name: 'x', prompt: 'p', every: 'daily', at: '9am' }).exitCode,
    ).toBe(1);
  });

  it('rejects an unknown --project', () => {
    const r = runAutomationsAdd({
      ...base(),
      name: 'x',
      prompt: 'p',
      every: 'hourly',
      project: 'does-not-exist',
    });
    expect(r.exitCode).toBe(1);
    expect(err.text()).toContain("unknown project 'does-not-exist'");
  });

  it('empty list prints a friendly hint', () => {
    const r = runAutomationsList(base());
    expect(r.exitCode).toBe(0);
    expect(err.text()).toContain('No automations defined');
  });

  // ── Phase 8D.2 — trigger automations ───────────────────────────────────────

  it('add --trigger creates a trigger automation (no schedule, null nextRun)', () => {
    const add = runAutomationsAdd({
      ...base(),
      name: 'gh-triage',
      prompt: 'triage the new issue',
      trigger: 'github_issue',
    });
    expect(add.exitCode).toBe(0);
    expect(err.text()).toContain("added automation 'gh-triage'");
    expect(err.text()).toContain('on new github_issue');

    out.lines = [];
    runAutomationsList({ ...base(), json: true });
    const parsed = JSON.parse(out.text());
    expect(parsed[0].triggerType).toBe('github_issue');
    expect(parsed[0].schedule).toBeNull();
    expect(parsed[0].nextRunAt).toBeNull();
  });

  it('rejects both --every and --trigger together', () => {
    const r = runAutomationsAdd({
      ...base(),
      name: 'x',
      prompt: 'p',
      every: 'daily',
      trigger: 'github_issue',
    });
    expect(r.exitCode).toBe(1);
    expect(err.text()).toContain('exactly one of --every');
  });

  it('rejects neither --every nor --trigger', () => {
    const r = runAutomationsAdd({ ...base(), name: 'x', prompt: 'p' });
    expect(r.exitCode).toBe(1);
    expect(err.text()).toContain('either --every');
  });

  it('rejects an unknown --trigger type', () => {
    const r = runAutomationsAdd({ ...base(), name: 'x', prompt: 'p', trigger: 'slack_message' });
    expect(r.exitCode).toBe(1);
    expect(err.text()).toContain('--trigger must be one of');
  });
});

describe('buildScheduleFromFlags', () => {
  it('maps flags to a schedule per interval', () => {
    expect(buildScheduleFromFlags({ every: 'hourly', at: '00:15' })).toEqual({
      type: 'hourly',
      minute: 15,
    });
    expect(buildScheduleFromFlags({ every: 'weekly', on: 'FRI', at: '17:30' })).toEqual({
      type: 'weekly',
      dayOfWeek: 'fri',
      hour: 17,
      minute: 30,
    });
    expect(buildScheduleFromFlags({ every: 'monthly', day: '15', at: '06:00' })).toEqual({
      type: 'monthly',
      dayOfMonth: 15,
      hour: 6,
      minute: 0,
    });
  });
});

describe('assertNoAutomationHostBrowserTarget', () => {
  it('no-ops without a target (8D.1 prompt-only automations)', () => {
    expect(() => assertNoAutomationHostBrowserTarget(undefined, new Set(['cdp']))).not.toThrow();
  });
  it('rejects a host-browser-control plugin target with an actionable message', () => {
    expect(() => assertNoAutomationHostBrowserTarget('cdp', new Set(['cdp']))).toThrow(
      AutomationTargetError,
    );
    expect(() => assertNoAutomationHostBrowserTarget('cdp', new Set(['cdp']))).toThrow(/Browserbase/);
  });
});
