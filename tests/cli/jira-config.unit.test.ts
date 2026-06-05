import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runJiraConfig } from '../../src/cli/jira-config.js';
import { loadJiraConfig } from '../../src/integrations/jira-config.js';
import { integrationsDir, readToken } from '../../src/integrations/secrets.js';

describe('runJiraConfig', () => {
  let home: string;
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-jira-home-'));
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

  it('stores the token (file backend under a home override) + site + email', async () => {
    const res = await runJiraConfig({
      token: 'tok',
      siteUrl: 'https://acme.atlassian.net',
      email: 'me@acme.io',
      home,
    });
    expect(res.exitCode).toBe(0);
    expect(await readToken('jira', home)).toBe('tok');
    const cfg = await loadJiraConfig(home);
    expect(cfg?.siteUrl).toBe('https://acme.atlassian.net');
    expect(cfg?.email).toBe('me@acme.io');
  });

  it('hints to set site+email when only a token is stored', async () => {
    const res = await runJiraConfig({ token: 'tok', home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('--site-url');
  });

  it('does NOT hint once site+email exist', async () => {
    await runJiraConfig({ siteUrl: 'https://acme.atlassian.net', email: 'me@acme.io', home });
    logs.length = 0;
    await runJiraConfig({ token: 'tok', home });
    expect(logs.join('\n')).not.toContain('to enable syncing');
  });

  it('accumulates project keys across invocations', async () => {
    await runJiraConfig({ projectKeys: ['ENG'], home });
    await runJiraConfig({ projectKeys: ['OPS'], home });
    expect((await loadJiraConfig(home))?.projectKeys).toEqual(['ENG', 'OPS']);
  });

  it('persists writeback comments + transition override', async () => {
    await runJiraConfig({
      siteUrl: 'https://acme.atlassian.net',
      email: 'me@acme.io',
      writebackCompleted: 'done!',
      writebackFailed: 'failed!',
      writebackTransition: 'Resolve',
      home,
    });
    const cfg = await loadJiraConfig(home);
    expect(cfg?.statusWriteback).toEqual({
      completed: 'done!',
      failed: 'failed!',
      completedTransition: 'Resolve',
    });
  });

  it('shows "not configured" when nothing is set and no config exists', async () => {
    const res = await runJiraConfig({ home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('not configured');
  });

  it('--status fails when not configured', async () => {
    const res = await runJiraConfig({ check: true, home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('not configured');
  });

  it('surfaces a malformed jira.json as exit 1', async () => {
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'jira.json'), '{ bad', 'utf8');
    const res = await runJiraConfig({ home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('jira.json');
  });
});
