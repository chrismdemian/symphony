import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProjectSectionSchema,
  readProjectConfig,
} from '../../src/worktree/symphony-config.js';

describe('Phase 5A — ProjectSectionSchema (Zod)', () => {
  it('parses an empty project section to an empty object', () => {
    const r = ProjectSectionSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it('parses every field at valid values', () => {
    const r = ProjectSectionSchema.safeParse({
      name: 'p',
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
      maestroWarmth: 0.4,
      droidsDir: '.symphony/droids',
      designInspiration: 'linear',
      gitRemote: 'origin',
      gitBranch: 'master',
      baseRef: 'origin/master',
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown keys (strict mode)', () => {
    const r = ProjectSectionSchema.safeParse({ unknownKey: 'oops' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /unrecognized/i.test(i.message))).toBe(true);
    }
  });

  it('rejects qualityPipeline outside enum', () => {
    const r = ProjectSectionSchema.safeParse({ qualityPipeline: 'bogus' });
    expect(r.success).toBe(false);
  });

  it('rejects defaultAutonomyTier outside {1,2,3}', () => {
    expect(ProjectSectionSchema.safeParse({ defaultAutonomyTier: 0 }).success).toBe(false);
    expect(ProjectSectionSchema.safeParse({ defaultAutonomyTier: 4 }).success).toBe(false);
    expect(ProjectSectionSchema.safeParse({ defaultAutonomyTier: 1.5 }).success).toBe(false);
  });

  it('rejects maestroWarmth outside [0, 1]', () => {
    expect(ProjectSectionSchema.safeParse({ maestroWarmth: -0.01 }).success).toBe(false);
    expect(ProjectSectionSchema.safeParse({ maestroWarmth: 1.01 }).success).toBe(false);
    expect(ProjectSectionSchema.safeParse({ maestroWarmth: 0 }).success).toBe(true);
    expect(ProjectSectionSchema.safeParse({ maestroWarmth: 1 }).success).toBe(true);
  });

  it('rejects maxConcurrentWorkers outside [1, 32] or non-integer', () => {
    expect(ProjectSectionSchema.safeParse({ maxConcurrentWorkers: 0 }).success).toBe(false);
    expect(ProjectSectionSchema.safeParse({ maxConcurrentWorkers: 33 }).success).toBe(false);
    expect(ProjectSectionSchema.safeParse({ maxConcurrentWorkers: 2.5 }).success).toBe(false);
  });

  it('rejects empty-string command fields', () => {
    expect(ProjectSectionSchema.safeParse({ testCommand: '' }).success).toBe(false);
    expect(ProjectSectionSchema.safeParse({ worktreeDir: '' }).success).toBe(false);
  });

  it('accepts designInspiration as string or null', () => {
    expect(ProjectSectionSchema.safeParse({ designInspiration: 'linear' }).success).toBe(true);
    expect(ProjectSectionSchema.safeParse({ designInspiration: null }).success).toBe(true);
    expect(ProjectSectionSchema.safeParse({ designInspiration: '' }).success).toBe(false);
  });

  it('audit-m4: accepts `previewUrl` (no-op; not propagated to overlay)', () => {
    expect(
      ProjectSectionSchema.safeParse({ previewUrl: 'http://localhost:3000' }).success,
    ).toBe(true);
    expect(ProjectSectionSchema.safeParse({ previewUrl: '' }).success).toBe(false);
  });
});

describe('Phase 5A — readProjectConfig (file loader)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-5a-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null overlay + empty warnings on missing file', () => {
    const r = readProjectConfig(dir);
    expect(r.overlay).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it('returns null overlay + warning on malformed JSON', () => {
    fs.writeFileSync(path.join(dir, '.symphony.json'), '{not json');
    const r = readProjectConfig(dir);
    expect(r.overlay).toBeNull();
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/malformed JSON/);
  });

  it('returns null overlay + warning when root is not an object', () => {
    fs.writeFileSync(path.join(dir, '.symphony.json'), '"not an object"');
    const r = readProjectConfig(dir);
    expect(r.overlay).toBeNull();
    expect(r.warnings[0]).toMatch(/root must be a JSON object/);
  });

  it('returns null overlay + no warning when `project` key is absent (legacy file)', () => {
    fs.writeFileSync(
      path.join(dir, '.symphony.json'),
      JSON.stringify({ preservePatterns: ['*.env'], worktreePool: { enabled: true } }),
    );
    const r = readProjectConfig(dir);
    expect(r.overlay).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it('returns null overlay + warning when `project` is not an object', () => {
    fs.writeFileSync(path.join(dir, '.symphony.json'), JSON.stringify({ project: 'oops' }));
    const r = readProjectConfig(dir);
    expect(r.overlay).toBeNull();
    expect(r.warnings[0]).toMatch(/`project` must be a JSON object/);
  });

  it('returns null overlay + warning on Zod failure (typo)', () => {
    fs.writeFileSync(
      path.join(dir, '.symphony.json'),
      JSON.stringify({ project: { qualityPipelin: 'full' } }),
    );
    const r = readProjectConfig(dir);
    expect(r.overlay).toBeNull();
    expect(r.warnings[0]).toMatch(/failed validation/);
  });

  it('returns a complete overlay when all fields are valid', () => {
    fs.writeFileSync(
      path.join(dir, '.symphony.json'),
      JSON.stringify({
        project: {
          name: 'symphony',
          defaultModel: 'opus',
          worktreeDir: '.symphony/wt',
          mcpConfig: '.mcp.json',
          maxConcurrentWorkers: 4,
          qualityPipeline: 'full',
          planModeRequired: true,
          defaultAutonomyTier: 2,
          previewCommand: 'pnpm dev',
          previewTimeoutMs: 30000,
          testCommand: 'pnpm test',
          buildCommand: 'pnpm build',
          lintCommand: 'pnpm lint',
          verifyCommand: 'pnpm verify',
          verifyTimeoutMs: 60000,
          finalizeDefault: 'push',
          maestroWarmth: 0.6,
          droidsDir: '.symphony/droids',
          designInspiration: 'linear',
        },
      }),
    );
    const r = readProjectConfig(dir);
    expect(r.warnings).toEqual([]);
    expect(r.declaredName).toBe('symphony');
    expect(r.overlay).toMatchObject({
      defaultModel: 'opus',
      worktreeDir: '.symphony/wt',
      mcpConfig: '.mcp.json',
      maxConcurrentWorkers: 4,
      qualityPipeline: 'full',
      planModeRequired: true,
      defaultAutonomyTier: 2,
      previewCommand: 'pnpm dev',
      previewTimeoutMs: 30000,
      testCommand: 'pnpm test',
      buildCommand: 'pnpm build',
      lintCommand: 'pnpm lint',
      verifyCommand: 'pnpm verify',
      verifyTimeoutMs: 60000,
      finalizeDefault: 'push',
      maestroWarmth: 0.6,
      droidsDir: '.symphony/droids',
      designInspiration: 'linear',
    });
    // `name` is NOT in the overlay (informational only in 5A).
    expect((r.overlay as Record<string, unknown>).name).toBeUndefined();
  });

  it('co-exists with the legacy top-level worktree-pool fields', () => {
    fs.writeFileSync(
      path.join(dir, '.symphony.json'),
      JSON.stringify({
        preservePatterns: ['*.env'],
        worktreePool: { enabled: true, size: 2 },
        project: { qualityPipeline: 'none' },
      }),
    );
    const r = readProjectConfig(dir);
    expect(r.warnings).toEqual([]);
    expect(r.overlay).toEqual({ qualityPipeline: 'none' });
  });

  it('drops null designInspiration to undefined in the overlay', () => {
    fs.writeFileSync(
      path.join(dir, '.symphony.json'),
      JSON.stringify({ project: { designInspiration: null } }),
    );
    const r = readProjectConfig(dir);
    expect(r.warnings).toEqual([]);
    expect(r.overlay).toEqual({});
  });

  it('returns an empty overlay for an empty project section', () => {
    fs.writeFileSync(
      path.join(dir, '.symphony.json'),
      JSON.stringify({ project: {} }),
    );
    const r = readProjectConfig(dir);
    expect(r.warnings).toEqual([]);
    expect(r.overlay).toEqual({});
  });

  it('audit-m4: `previewUrl` in `project` parses cleanly but is NOT in overlay', () => {
    fs.writeFileSync(
      path.join(dir, '.symphony.json'),
      JSON.stringify({
        project: { previewUrl: 'http://localhost:3000', qualityPipeline: 'full' },
      }),
    );
    const r = readProjectConfig(dir);
    expect(r.warnings).toEqual([]);
    // `previewUrl` accepted by Zod but the loader doesn't propagate it.
    expect(r.overlay).toEqual({ qualityPipeline: 'full' });
  });
});
