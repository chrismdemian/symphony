/**
 * Phase 5A production scenario — exercises `.symphony.json` `project`
 * section persistence end-to-end through the public Symphony surface:
 * `mergeProjectConfigsWithFiles` (the boot-time merge helper) +
 * `SqliteProjectStore.register` (the same store `startOrchestratorServer`
 * constructs).
 *
 * See `tests/scenarios/5a.md` for the Given/When/Then.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mergeProjectConfigsWithFiles } from '../../src/orchestrator/server.js';
import { SqliteProjectStore } from '../../src/state/sqlite-project-store.js';
import { SymphonyDatabase } from '../../src/state/db.js';

describe('Phase 5A scenario — .symphony.json → ProjectRecord (real fs + real sqlite)', () => {
  let dir: string;
  let svc: SymphonyDatabase;
  let store: SqliteProjectStore;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-5a-scn-'));
    svc = SymphonyDatabase.open({ filePath: ':memory:' });
    store = new SqliteProjectStore(svc.db);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    svc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeProject(name: string, body: object): string {
    const projDir = path.join(dir, name);
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, '.symphony.json'), JSON.stringify(body, null, 2));
    return projDir;
  }

  it('Given+When+Then — full / broken / override projects all behave per the contract', () => {
    // Given
    const fullPath = makeProject('proj-full', {
      project: {
        name: 'proj-full',
        defaultModel: 'opus',
        worktreeDir: '.symphony/worktrees',
        mcpConfig: '.mcp.json',
        maxConcurrentWorkers: 4,
        qualityPipeline: 'full',
        planModeRequired: true,
        defaultAutonomyTier: 2,
        previewCommand: 'pnpm dev',
        previewTimeoutMs: 30_000,
        testCommand: 'pnpm test',
        buildCommand: 'pnpm build',
        lintCommand: 'pnpm lint',
        verifyCommand: 'pnpm verify',
        verifyTimeoutMs: 60_000,
        finalizeDefault: 'push',
        maestroWarmth: 0.6,
        droidsDir: '.symphony/droids',
        designInspiration: 'linear',
      },
    });
    const brokenPath = makeProject('proj-broken', {
      project: { qualityPipelin: 'full' },
    });
    const overridePath = makeProject('proj-override', {
      project: { qualityPipeline: 'simplified', testCommand: 'file-test' },
    });

    // When
    const merged = mergeProjectConfigsWithFiles(
      {
        'proj-full': fullPath,
        'proj-broken': brokenPath,
        'proj-override': overridePath,
      },
      {
        'proj-override': { qualityPipeline: 'full' },
      },
    );

    // Register each merged config (mirrors what seedProjectsFromMap does)
    for (const [name, projPath] of Object.entries({
      'proj-full': fullPath,
      'proj-broken': brokenPath,
      'proj-override': overridePath,
    })) {
      store.register({
        id: name,
        name,
        path: projPath,
        createdAt: '',
        ...merged[name],
      });
    }

    // Then — proj-full: every field flows from the file
    const full = store.get('proj-full')!;
    expect(full.defaultModel).toBe('opus');
    expect(full.worktreeDir).toBe('.symphony/worktrees');
    expect(full.mcpConfig).toBe('.mcp.json');
    expect(full.maxConcurrentWorkers).toBe(4);
    expect(full.qualityPipeline).toBe('full');
    expect(full.planModeRequired).toBe(true);
    expect(full.defaultAutonomyTier).toBe(2);
    expect(full.previewCommand).toBe('pnpm dev');
    expect(full.previewTimeoutMs).toBe(30_000);
    expect(full.testCommand).toBe('pnpm test');
    expect(full.buildCommand).toBe('pnpm build');
    expect(full.lintCommand).toBe('pnpm lint');
    expect(full.verifyCommand).toBe('pnpm verify');
    expect(full.verifyTimeoutMs).toBe(60_000);
    expect(full.finalizeDefault).toBe('push');
    expect(full.maestroWarmth).toBeCloseTo(0.6);
    expect(full.droidsDir).toBe('.symphony/droids');
    expect(full.designInspiration).toBe('linear');

    // Then — proj-broken: Zod failure warned but record has no overlay
    const broken = store.get('proj-broken')!;
    expect(broken.qualityPipeline).toBeUndefined();
    expect(broken.planModeRequired).toBeUndefined();
    expect(broken.defaultAutonomyTier).toBeUndefined();

    // Then — proj-override: caller wins over file
    const overridden = store.get('proj-override')!;
    expect(overridden.qualityPipeline).toBe('full');
    expect(overridden.testCommand).toBe('file-test'); // not overridden by caller

    // Warn was called exactly once (for proj-broken)
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnedMessage = (warnSpy.mock.calls[0]?.[0] as string) ?? '';
    expect(warnedMessage).toMatch(/proj-broken/);
    expect(warnedMessage).toMatch(/failed validation/);
  });
});
