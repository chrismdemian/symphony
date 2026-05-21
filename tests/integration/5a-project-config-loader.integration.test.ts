/**
 * Phase 5A — integration test: `.symphony.json` `project` section loader
 * end-to-end through `seedProjectsFromMap`.
 *
 * Real filesystem + real SQLite. Asserts:
 *   - file overlay flows into `ProjectRecord` when no caller override
 *   - caller `options.projectConfigs[name]` wins over file values
 *   - malformed `.symphony.json` doesn't crash boot; warnings are logged
 *
 * Driven via the exported `mergeProjectConfigsWithFiles` helper +
 * `SqliteProjectStore` to keep the surface small. Phase 5A scenario test
 * exercises the full `startOrchestratorServer` boot path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mergeProjectConfigsWithFiles } from '../../src/orchestrator/server.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SymphonyDatabase } from '../../src/state/db.js';

// We test the merge helper directly + the store round-trip side-by-side.
// `seedProjectsFromMap` is module-private; the full end-to-end through
// `startOrchestratorServer` is exercised by `tests/scenarios/5a.test.ts`.

describe('Phase 5A — .symphony.json loader → ProjectRecord', () => {
  let dir: string;
  let svc: SymphonyDatabase;
  let store: SqliteProjectStore;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-5a-int-'));
    svc = SymphonyDatabase.open({ filePath: ':memory:' });
    store = new SqliteProjectStore(svc.db);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    svc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(projectDir: string, body: object): void {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.symphony.json'), JSON.stringify(body, null, 2));
  }

  function registerWithMerged(
    name: string,
    projectPath: string,
    merged: Record<string, unknown> | undefined,
  ): void {
    store.register({
      id: name,
      name,
      path: projectPath,
      createdAt: '',
      ...((merged ?? {}) as object),
    });
  }

  it('flows file overlay into ProjectRecord when no caller override', () => {
    const projectDir = path.join(dir, 'proj-a');
    writeConfig(projectDir, {
      project: {
        qualityPipeline: 'simplified',
        planModeRequired: true,
        defaultAutonomyTier: 2,
        maestroWarmth: 0.7,
        testCommand: 'pnpm test',
        verifyCommand: 'pnpm verify',
        designInspiration: 'linear',
      },
    });

    const merged = mergeProjectConfigsWithFiles({ a: projectDir }, undefined);
    registerWithMerged('a', projectDir, merged.a);

    const rec = store.get('a')!;
    expect(rec.qualityPipeline).toBe('simplified');
    expect(rec.planModeRequired).toBe(true);
    expect(rec.defaultAutonomyTier).toBe(2);
    expect(rec.maestroWarmth).toBeCloseTo(0.7);
    expect(rec.testCommand).toBe('pnpm test');
    expect(rec.verifyCommand).toBe('pnpm verify');
    expect(rec.designInspiration).toBe('linear');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('caller `options.projectConfigs[name]` wins over file values', () => {
    const projectDir = path.join(dir, 'proj-b');
    writeConfig(projectDir, {
      project: {
        qualityPipeline: 'simplified',
        testCommand: 'file-test',
        maestroWarmth: 0.2,
      },
    });

    const merged = mergeProjectConfigsWithFiles(
      { b: projectDir },
      {
        b: {
          qualityPipeline: 'full',
          testCommand: 'caller-test',
        },
      },
    );
    registerWithMerged('b', projectDir, merged.b);

    const rec = store.get('b')!;
    expect(rec.qualityPipeline).toBe('full'); // caller wins
    expect(rec.testCommand).toBe('caller-test'); // caller wins
    expect(rec.maestroWarmth).toBeCloseTo(0.2); // file (no override)
  });

  it('malformed `.symphony.json` warns but does not crash; record gets no overlay', () => {
    const projectDir = path.join(dir, 'proj-c');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.symphony.json'), '{not json}');

    const merged = mergeProjectConfigsWithFiles({ c: projectDir }, undefined);
    registerWithMerged('c', projectDir, merged.c);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect((warnSpy.mock.calls[0]?.[0] as string) ?? '').toMatch(/malformed JSON/);
    const rec = store.get('c')!;
    expect(rec.qualityPipeline).toBeUndefined();
  });

  it('Zod failure (unknown key) warns but does not crash', () => {
    const projectDir = path.join(dir, 'proj-d');
    writeConfig(projectDir, { project: { qualityPipelin: 'full' } });

    const merged = mergeProjectConfigsWithFiles({ d: projectDir }, undefined);
    registerWithMerged('d', projectDir, merged.d);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect((warnSpy.mock.calls[0]?.[0] as string) ?? '').toMatch(/failed validation/);
    const rec = store.get('d')!;
    expect(rec.qualityPipeline).toBeUndefined();
  });

  it('legacy `.symphony.json` (worktree-pool only, no `project`) loads cleanly', () => {
    const projectDir = path.join(dir, 'proj-e');
    writeConfig(projectDir, {
      preservePatterns: ['*.env'],
      worktreePool: { enabled: true, size: 2 },
    });

    const merged = mergeProjectConfigsWithFiles({ e: projectDir }, undefined);
    registerWithMerged('e', projectDir, merged.e);

    expect(warnSpy).not.toHaveBeenCalled();
    const rec = store.get('e')!;
    expect(rec.qualityPipeline).toBeUndefined();
  });

  it('audit-M1 regression: preserves caller-only configs (no `projects` map counterpart)', () => {
    // Caller passes `projectConfigs` for a name that has NO corresponding
    // entry in `projects` — e.g. a 5B add-then-register-via-config path.
    // The merged map MUST still contain the caller's overlay; the pre-fix
    // implementation iterated only `Object.entries(projects)` and dropped it.
    const merged = mergeProjectConfigsWithFiles(
      {},
      {
        'caller-only': { qualityPipeline: 'simplified', testCommand: 'caller-test' },
      },
    );
    expect(merged['caller-only']).toEqual({
      qualityPipeline: 'simplified',
      testCommand: 'caller-test',
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('audit-M1 regression: caller-only entries co-exist with projects-map entries', () => {
    const projectDir = path.join(dir, 'proj-mix');
    writeConfig(projectDir, { project: { qualityPipeline: 'full' } });
    const merged = mergeProjectConfigsWithFiles(
      { mapped: projectDir },
      {
        'caller-only': { qualityPipeline: 'none' },
        mapped: { testCommand: 'caller-wins' },
      },
    );
    expect(merged['caller-only']).toEqual({ qualityPipeline: 'none' });
    expect(merged.mapped?.qualityPipeline).toBe('full');
    expect(merged.mapped?.testCommand).toBe('caller-wins');
  });

  it('missing `.symphony.json` returns empty overlay silently (common path)', () => {
    const projectDir = path.join(dir, 'proj-f');
    fs.mkdirSync(projectDir, { recursive: true });

    const merged = mergeProjectConfigsWithFiles({ f: projectDir }, undefined);
    registerWithMerged('f', projectDir, merged.f);

    expect(warnSpy).not.toHaveBeenCalled();
    const rec = store.get('f')!;
    expect(rec.qualityPipeline).toBeUndefined();
    expect(rec.planModeRequired).toBeUndefined();
  });
});
