import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runForgejoConfig } from '../../src/cli/forgejo-config.js';
import { loadForgejoConfig } from '../../src/integrations/forgejo-config.js';
import { integrationsDir, readToken } from '../../src/integrations/secrets.js';

describe('runForgejoConfig', () => {
  let home: string;
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-fj-home-'));
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

  it('stores the token (file backend under a home override) + site URL + repos', async () => {
    const res = await runForgejoConfig({
      token: 'fj-abc',
      siteUrl: 'https://code.acme.com',
      repos: ['acme/app'],
      home,
    });
    expect(res.exitCode).toBe(0);
    expect(await readToken('forgejo', home)).toBe('fj-abc');
    const cfg = await loadForgejoConfig(home);
    expect(cfg?.repos).toEqual(['acme/app']);
    expect(cfg?.siteUrl).toBe('https://code.acme.com');
  });

  it('hints for site URL + repo when only a token is stored', async () => {
    const res = await runForgejoConfig({ token: 'fj-abc', home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('instance URL');
    expect(logs.join('\n')).toContain('add at least one repo');
  });

  it('does NOT hint once site URL + repos exist', async () => {
    await runForgejoConfig({ siteUrl: 'https://code.acme.com', repos: ['acme/app'], home });
    logs.length = 0;
    await runForgejoConfig({ token: 'fj-abc', home });
    expect(logs.join('\n')).not.toContain('add at least one repo');
    expect(logs.join('\n')).not.toContain('instance URL');
  });

  it('accumulates repos across invocations', async () => {
    await runForgejoConfig({ repos: ['acme/app'], home });
    await runForgejoConfig({ repos: ['acme/api'], home });
    expect((await loadForgejoConfig(home))?.repos).toEqual(['acme/app', 'acme/api']);
  });

  it('persists writeback comments + site url', async () => {
    await runForgejoConfig({
      repos: ['acme/app'],
      siteUrl: 'https://code.acme.com',
      writebackCompleted: 'done!',
      writebackFailed: 'failed!',
      home,
    });
    const cfg = await loadForgejoConfig(home);
    expect(cfg?.siteUrl).toBe('https://code.acme.com');
    expect(cfg?.statusWriteback).toEqual({ completed: 'done!', failed: 'failed!' });
  });

  it('shows "not configured" when nothing is set and no config exists', async () => {
    const res = await runForgejoConfig({ home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('not configured');
  });

  it('--status fails when not configured', async () => {
    const res = await runForgejoConfig({ check: true, home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('not configured');
  });

  it('surfaces a malformed forgejo.json as exit 1', async () => {
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'forgejo.json'), '{ bad', 'utf8');
    const res = await runForgejoConfig({ home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('forgejo.json');
  });
});
