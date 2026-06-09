import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSentryConfig } from '../../src/cli/sentry-config.js';
import { loadSentryConfig } from '../../src/integrations/sentry-config.js';
import { integrationsDir, readToken } from '../../src/integrations/secrets.js';

describe('runSentryConfig', () => {
  let home: string;
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-sentry-home-'));
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

  it('stores the token (file backend under a home override) + org + projects', async () => {
    const res = await runSentryConfig({
      token: 'sntry-abc',
      org: 'acme',
      projects: ['backend'],
      home,
    });
    expect(res.exitCode).toBe(0);
    expect(await readToken('sentry', home)).toBe('sntry-abc');
    const cfg = await loadSentryConfig(home);
    expect(cfg?.org).toBe('acme');
    expect(cfg?.projects).toEqual(['backend']);
  });

  it('persists the opt-in resolve flag + writeback notes + base url', async () => {
    await runSentryConfig({
      org: 'acme',
      projects: ['backend'],
      baseUrl: 'https://us.sentry.io',
      writebackCompleted: 'looked into it',
      writebackFailed: 'could not finish',
      writebackResolve: true,
      home,
    });
    const cfg = await loadSentryConfig(home);
    expect(cfg?.baseUrl).toBe('https://us.sentry.io');
    expect(cfg?.resolveOnCompleted).toBe(true);
    expect(cfg?.statusWriteback).toEqual({ completed: 'looked into it', failed: 'could not finish' });
  });

  it('hints for org + project when only a token is stored', async () => {
    const res = await runSentryConfig({ token: 'sntry-abc', home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('set your org');
    expect(logs.join('\n')).toContain('add at least one project');
  });

  it('does NOT hint once org + projects exist', async () => {
    await runSentryConfig({ org: 'acme', projects: ['backend'], home });
    logs.length = 0;
    await runSentryConfig({ token: 'sntry-abc', home });
    expect(logs.join('\n')).not.toContain('set your org');
    expect(logs.join('\n')).not.toContain('add at least one project');
  });

  it('accumulates projects across invocations', async () => {
    await runSentryConfig({ projects: ['backend'], home });
    await runSentryConfig({ projects: ['frontend'], home });
    expect((await loadSentryConfig(home))?.projects).toEqual(['backend', 'frontend']);
  });

  it('shows "not configured" when nothing is set and no config exists', async () => {
    const res = await runSentryConfig({ home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('not configured');
  });

  it('--status fails when not configured', async () => {
    const res = await runSentryConfig({ check: true, home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('not configured');
  });

  it('surfaces a malformed sentry.json as exit 1', async () => {
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'sentry.json'), '{ bad', 'utf8');
    const res = await runSentryConfig({ home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('sentry.json');
  });
});
