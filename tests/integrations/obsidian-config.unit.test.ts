import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultObsidianConfig,
  loadObsidianConfig,
  ObsidianConfigError,
  resolveStatusMap,
  saveObsidianConfig,
} from '../../src/integrations/obsidian-config.js';
import { integrationsDir } from '../../src/integrations/secrets.js';

describe('obsidian-config', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-obs-cfg-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('defaultObsidianConfig fills sensible defaults from a bare vault path', () => {
    const cfg = defaultObsidianConfig('/vault');
    expect(cfg.vaultPath).toBe('/vault');
    expect(cfg.taskFormat).toBe('auto');
    expect(cfg.projectProperty).toBe('project');
    expect(cfg.watch).toBe(true);
    expect(cfg.statusWriteback.completed).toBe('x');
    expect(cfg.statusWriteback.appendDoneDate).toBe(true);
    expect(cfg.statusWriteback.failed).toBeUndefined();
  });

  it('loadObsidianConfig returns undefined when unconfigured', async () => {
    expect(await loadObsidianConfig(home)).toBeUndefined();
  });

  it('saveObsidianConfig resolves the vault path to absolute and round-trips', async () => {
    await saveObsidianConfig({ vaultPath: '.', taskFormat: 'emoji' }, home);
    const loaded = await loadObsidianConfig(home);
    expect(loaded?.vaultPath).toBe(path.resolve('.'));
    expect(loaded?.taskFormat).toBe('emoji');
    // Defaults filled.
    expect(loaded?.projectProperty).toBe('project');
    expect(loaded?.watch).toBe(true);
  });

  it('successive saves accumulate non-conflicting fields', async () => {
    await saveObsidianConfig({ vaultPath: '/vault' }, home);
    await saveObsidianConfig({ projectProperty: 'route' }, home);
    await saveObsidianConfig({ watch: false }, home);
    const loaded = await loadObsidianConfig(home);
    expect(loaded?.vaultPath).toBe(path.resolve('/vault'));
    expect(loaded?.projectProperty).toBe('route');
    expect(loaded?.watch).toBe(false);
  });

  it('rejects saving without a vault path when none exists yet', async () => {
    await expect(saveObsidianConfig({ projectProperty: 'x' }, home)).rejects.toBeInstanceOf(
      ObsidianConfigError,
    );
  });

  it('throws ObsidianConfigError on malformed JSON (never silent unconfigured)', async () => {
    const dir = integrationsDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'obsidian.json'), '{ not valid json', 'utf8');
    await expect(loadObsidianConfig(home)).rejects.toBeInstanceOf(ObsidianConfigError);
  });

  it('throws ObsidianConfigError when a stored config fails schema validation', async () => {
    const dir = integrationsDir(home);
    mkdirSync(dir, { recursive: true });
    // taskFormat must be one of emoji|dataview|auto.
    writeFileSync(
      path.join(dir, 'obsidian.json'),
      JSON.stringify({ vaultPath: '/v', taskFormat: 'nonsense' }),
      'utf8',
    );
    await expect(loadObsidianConfig(home)).rejects.toBeInstanceOf(ObsidianConfigError);
  });
});

describe('resolveStatusMap', () => {
  it('returns the parser defaults when no overrides are configured', () => {
    const cfg = defaultObsidianConfig('/v');
    const map = resolveStatusMap(cfg);
    expect(map[' ']).toEqual({ status: 'pending', terminal: false });
    expect(map['x']).toEqual({ status: 'completed', terminal: true });
  });

  it('merges a user statusImport over the defaults (keeping the rest)', () => {
    const cfg = { ...defaultObsidianConfig('/v'), statusImport: { '>': 'in_progress' as const } };
    const map = resolveStatusMap(cfg);
    // overridden
    expect(map['>']?.status).toBe('in_progress');
    // defaults preserved
    expect(map['x']).toEqual({ status: 'completed', terminal: true });
  });

  it('applies a statusTerminal override for an otherwise-default char', () => {
    const cfg = { ...defaultObsidianConfig('/v'), statusTerminal: { '/': true } };
    const map = resolveStatusMap(cfg);
    expect(map['/']).toEqual({ status: 'in_progress', terminal: true });
  });
});
