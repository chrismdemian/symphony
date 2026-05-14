import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configFilePath,
  defaultConfig,
  loadConfig,
  saveConfig,
  symphonyDataDir,
  SYMPHONY_CONFIG_FILE_ENV,
} from '../../src/utils/config.js';

describe('config helper', () => {
  let tmp: string;
  let cfgFile: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'symphony-config-'));
    cfgFile = join(tmp, 'config.json');
    originalEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
    delete process.env[SYMPHONY_CONFIG_FILE_ENV];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[SYMPHONY_CONFIG_FILE_ENV];
    } else {
      process.env[SYMPHONY_CONFIG_FILE_ENV] = originalEnv;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('symphonyDataDir() composes ~/.symphony', () => {
    const home = '/home/chris';
    expect(symphonyDataDir(home)).toBe(join(home, '.symphony'));
  });

  it('configFilePath() honors SYMPHONY_CONFIG_FILE override', () => {
    process.env[SYMPHONY_CONFIG_FILE_ENV] = cfgFile;
    expect(configFilePath()).toBe(cfgFile);
  });

  it('configFilePath() falls back to ~/.symphony/config.json by default', () => {
    const home = '/home/chris';
    expect(configFilePath(home)).toBe(join(home, '.symphony', 'config.json'));
  });

  it('loadConfig() returns defaults + source.kind=default on ENOENT', async () => {
    const result = await loadConfig(cfgFile);
    expect(result.config).toEqual(defaultConfig());
    expect(result.source.kind).toBe('default');
  });

  it('loadConfig() reads a valid file with source.kind=file', async () => {
    writeFileSync(
      cfgFile,
      JSON.stringify({ schemaVersion: 1, modelMode: 'opus', maxConcurrentWorkers: 8 }, null, 2),
      'utf8',
    );
    const result = await loadConfig(cfgFile);
    expect(result.config.modelMode).toBe('opus');
    expect(result.config.maxConcurrentWorkers).toBe(8);
    expect(result.source.kind).toBe('file');
    if (result.source.kind === 'file') {
      expect(result.source.warnings).toEqual([]);
    }
  });

  it('loadConfig() returns defaults + warning on malformed JSON', async () => {
    writeFileSync(cfgFile, '{ this is not json', 'utf8');
    const result = await loadConfig(cfgFile);
    expect(result.config).toEqual(defaultConfig());
    expect(result.source.kind).toBe('file');
    if (result.source.kind === 'file') {
      expect(result.source.warnings.length).toBeGreaterThan(0);
      expect(result.source.warnings[0]).toContain('parse');
    }
  });

  it('loadConfig() salvages a partial file with bad fields', async () => {
    writeFileSync(
      cfgFile,
      JSON.stringify({ modelMode: 'opus', maxConcurrentWorkers: -99 }, null, 2),
      'utf8',
    );
    const result = await loadConfig(cfgFile);
    expect(result.config.modelMode).toBe('opus');
    expect(result.config.maxConcurrentWorkers).toBe(4);
    if (result.source.kind === 'file') {
      expect(result.source.warnings.some((w) => w.includes('maxConcurrentWorkers'))).toBe(true);
    }
  });

  it('saveConfig() writes a fresh file with content matching config', async () => {
    const cfg = { ...defaultConfig(), modelMode: 'opus' as const, maxConcurrentWorkers: 6 };
    await saveConfig(cfg, cfgFile);
    const text = readFileSync(cfgFile, 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['modelMode']).toBe('opus');
    expect(parsed['maxConcurrentWorkers']).toBe(6);
    expect(parsed['schemaVersion']).toBe(1);
  });

  it('saveConfig() round-trips through loadConfig', async () => {
    const cfg = {
      ...defaultConfig(),
      modelMode: 'opus' as const,
      maxConcurrentWorkers: 12,
      defaultProjectPath: '/tmp/foo',
    };
    await saveConfig(cfg, cfgFile);
    const loaded = await loadConfig(cfgFile);
    expect(loaded.config.modelMode).toBe('opus');
    expect(loaded.config.maxConcurrentWorkers).toBe(12);
    expect(loaded.config.defaultProjectPath).toBe('/tmp/foo');
  });

  it('saveConfig() preserves a JSONC comment on round-trip', async () => {
    writeFileSync(
      cfgFile,
      `{
  // user's pick — opus mode for important sessions
  "schemaVersion": 1,
  "modelMode": "opus",
  "maxConcurrentWorkers": 4
}
`,
      'utf8',
    );
    const cfg = { ...defaultConfig(), modelMode: 'opus' as const, maxConcurrentWorkers: 8 };
    await saveConfig(cfg, cfgFile);
    const text = readFileSync(cfgFile, 'utf8');
    expect(text).toContain('// user');
    expect(text).toContain('"maxConcurrentWorkers": 8');
  });

  it('saveConfig() chmods to 0o600 on POSIX', async () => {
    if (process.platform === 'win32') return; // chmod is no-op on Win32
    // Pre-create with 0o644 to verify chmod actually fires.
    writeFileSync(cfgFile, '{}', 'utf8');
    chmodSync(cfgFile, 0o644);
    await saveConfig(defaultConfig(), cfgFile);
    const stat = statSync(cfgFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('saveConfig() drops defaultProjectPath when undefined in next', async () => {
    writeFileSync(
      cfgFile,
      JSON.stringify({ schemaVersion: 1, defaultProjectPath: '/old/path' }, null, 2),
      'utf8',
    );
    await saveConfig(defaultConfig(), cfgFile);
    const text = readFileSync(cfgFile, 'utf8');
    expect(text).not.toContain('defaultProjectPath');
  });

  it('saveConfig() round-trips autonomyTier (3S)', async () => {
    const cfg = { ...defaultConfig(), autonomyTier: 3 as const };
    await saveConfig(cfg, cfgFile);
    const loaded = await loadConfig(cfgFile);
    expect(loaded.config.autonomyTier).toBe(3);
  });

  it('saveConfig() persists autonomyTier in the on-disk JSON (3S)', async () => {
    const cfg = { ...defaultConfig(), autonomyTier: 1 as const };
    await saveConfig(cfg, cfgFile);
    const text = readFileSync(cfgFile, 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['autonomyTier']).toBe(1);
  });
});
