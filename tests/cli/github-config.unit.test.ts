import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGitHubConfig } from '../../src/cli/github-config.js';
import { loadGitHubConfig } from '../../src/integrations/github-config.js';
import { integrationsDir, readToken } from '../../src/integrations/secrets.js';

describe('runGitHubConfig', () => {
  let home: string;
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-gh-home-'));
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

  it('stores the token (file backend under a home override) and repos', async () => {
    const res = await runGitHubConfig({ token: 'ghp_abc', repos: ['acme/app'], home });
    expect(res.exitCode).toBe(0);
    expect(await readToken('github', home)).toBe('ghp_abc');
    expect((await loadGitHubConfig(home))?.repos).toEqual(['acme/app']);
  });

  it('hints to add a repo when only a token is stored (no repos yet)', async () => {
    const res = await runGitHubConfig({ token: 'ghp_abc', home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('add at least one repo');
  });

  it('does NOT hint to add a repo once repos exist', async () => {
    await runGitHubConfig({ repos: ['acme/app'], home });
    logs.length = 0;
    await runGitHubConfig({ token: 'ghp_abc', home });
    expect(logs.join('\n')).not.toContain('add at least one repo');
  });

  it('accumulates repos across invocations', async () => {
    await runGitHubConfig({ repos: ['acme/app'], home });
    await runGitHubConfig({ repos: ['acme/api'], home });
    expect((await loadGitHubConfig(home))?.repos).toEqual(['acme/app', 'acme/api']);
  });

  it('persists writeback comments + api base url', async () => {
    await runGitHubConfig({
      repos: ['acme/app'],
      apiBaseUrl: 'https://github.acme.com/api/v3',
      writebackCompleted: 'done!',
      writebackFailed: 'failed!',
      home,
    });
    const cfg = await loadGitHubConfig(home);
    expect(cfg?.apiBaseUrl).toBe('https://github.acme.com/api/v3');
    expect(cfg?.statusWriteback).toEqual({ completed: 'done!', failed: 'failed!' });
  });

  it('shows "not configured" when nothing is set and no config exists', async () => {
    const res = await runGitHubConfig({ home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('not configured');
  });

  it('--status fails when not configured', async () => {
    const res = await runGitHubConfig({ check: true, home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('not configured');
  });

  it('surfaces a malformed github.json as exit 1', async () => {
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'github.json'), '{ bad', 'utf8');
    const res = await runGitHubConfig({ home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('github.json');
  });
});
