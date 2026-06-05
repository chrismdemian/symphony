import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGitLabConfig } from '../../src/cli/gitlab-config.js';
import { loadGitLabConfig } from '../../src/integrations/gitlab-config.js';
import { integrationsDir, readToken } from '../../src/integrations/secrets.js';

describe('runGitLabConfig', () => {
  let home: string;
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-gl-home-'));
    logs = [];
    errs = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      errs.push(String(m));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('stores the token (file backend under a home override) and projects', async () => {
    const res = await runGitLabConfig({ token: 'glpat-abc', projects: ['acme/app'], home });
    expect(res.exitCode).toBe(0);
    expect(await readToken('gitlab', home)).toBe('glpat-abc');
    expect((await loadGitLabConfig(home))?.projects).toEqual(['acme/app']);
  });

  it('hints to add a project when only a token is stored (no projects yet)', async () => {
    const res = await runGitLabConfig({ token: 'glpat-abc', home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('add at least one project');
  });

  it('does NOT hint to add a project once projects exist', async () => {
    await runGitLabConfig({ projects: ['acme/app'], home });
    logs.length = 0;
    await runGitLabConfig({ token: 'glpat-abc', home });
    expect(logs.join('\n')).not.toContain('add at least one project');
  });

  it('accumulates projects across invocations', async () => {
    await runGitLabConfig({ projects: ['acme/app'], home });
    await runGitLabConfig({ projects: ['acme/api'], home });
    expect((await loadGitLabConfig(home))?.projects).toEqual(['acme/app', 'acme/api']);
  });

  it('persists writeback notes + self-hosted site url', async () => {
    await runGitLabConfig({
      projects: ['acme/app'],
      siteUrl: 'https://gitlab.acme.com',
      writebackCompleted: 'done!',
      writebackFailed: 'failed!',
      home,
    });
    const cfg = await loadGitLabConfig(home);
    expect(cfg?.siteUrl).toBe('https://gitlab.acme.com');
    expect(cfg?.statusWriteback).toEqual({ completed: 'done!', failed: 'failed!' });
  });

  it('shows "not configured" when nothing is set and no config exists', async () => {
    const res = await runGitLabConfig({ home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('not configured');
  });

  it('--status fails when not configured', async () => {
    const res = await runGitLabConfig({ check: true, home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('not configured');
  });

  it('surfaces a malformed gitlab.json as exit 1', async () => {
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'gitlab.json'), '{ bad', 'utf8');
    const res = await runGitLabConfig({ home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('gitlab.json');
  });
});
