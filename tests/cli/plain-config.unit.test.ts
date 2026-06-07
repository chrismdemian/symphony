import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPlainConfig } from '../../src/cli/plain-config.js';
import { loadPlainConfig } from '../../src/integrations/plain-config.js';
import { integrationsDir, readToken } from '../../src/integrations/secrets.js';

describe('runPlainConfig', () => {
  let home: string;
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-plain-home-'));
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

  it('stores the token (file backend under a home override)', async () => {
    const res = await runPlainConfig({ token: 'plain-key', home });
    expect(res.exitCode).toBe(0);
    expect(await readToken('plain', home)).toBe('plain-key');
  });

  it('persists api url, statuses, and writeback notes', async () => {
    await runPlainConfig({
      apiUrl: 'https://core-api.eu.plain.com/graphql/v1',
      statuses: ['todo', 'snoozed'],
      writebackCompleted: 'done!',
      writebackFailed: 'failed!',
      home,
    });
    const cfg = await loadPlainConfig(home);
    expect(cfg?.apiUrl).toBe('https://core-api.eu.plain.com/graphql/v1');
    expect(cfg?.statuses).toEqual(['TODO', 'SNOOZED']); // normalized to upper-case
    expect(cfg?.statusWriteback).toEqual({ completed: 'done!', failed: 'failed!' });
  });

  it('rejects an unknown status with exit 1', async () => {
    const res = await runPlainConfig({ statuses: ['nope'], home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('unknown thread status');
  });

  it('shows "not configured" when nothing is set and no config exists', async () => {
    const res = await runPlainConfig({ home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('not configured');
  });

  it('shows current config once a token is stored', async () => {
    await runPlainConfig({ token: 'plain-key', home });
    logs.length = 0;
    const res = await runPlainConfig({ home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('plain configuration');
    expect(logs.join('\n')).toContain('stored');
  });

  it('--status fails when not configured', async () => {
    const res = await runPlainConfig({ check: true, home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('not configured');
  });

  it('surfaces a malformed plain.json as exit 1', async () => {
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'plain.json'), '{ bad', 'utf8');
    const res = await runPlainConfig({ home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('plain.json');
  });
});
