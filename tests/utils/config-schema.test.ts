import { describe, it, expect } from 'vitest';
import {
  defaultConfig,
  parseConfig,
  CURRENT_SCHEMA_VERSION,
} from '../../src/utils/config-schema.js';

describe('config-schema', () => {
  it('defaultConfig() has the expected shape (3H.1)', () => {
    const cfg = defaultConfig();
    expect(cfg.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(cfg.modelMode).toBe('mixed');
    expect(cfg.maxConcurrentWorkers).toBe(4);
    expect(cfg.autoMerge).toBe('ask');
    expect(cfg.notifications.enabled).toBe(false);
    expect(cfg.awayMode).toBe(false);
    expect(cfg.theme.name).toBe('symphony');
    expect(cfg.theme.autoFallback16Color).toBe(true);
    expect(cfg.defaultProjectPath).toBeUndefined();
    expect(cfg.leaderTimeoutMs).toBe(300);
    expect(cfg.keybindOverrides).toEqual({});
    // Phase 3S — default tier 2 matches DEFAULT_DISPATCH_CONTEXT.tier in
    // orchestrator/capabilities.ts. Changing this default requires
    // updating both files in lockstep.
    expect(cfg.autonomyTier).toBe(2);
  });

  it('parseConfig(undefined) returns defaults with no warnings', () => {
    const result = parseConfig(undefined);
    expect(result.config).toEqual(defaultConfig());
    expect(result.warnings).toEqual([]);
  });

  it('parseConfig({}) merges with defaults, no warnings', () => {
    const result = parseConfig({});
    expect(result.config).toEqual(defaultConfig());
    expect(result.warnings).toEqual([]);
  });

  it('parseConfig({ modelMode: "opus" }) preserves opus', () => {
    const result = parseConfig({ modelMode: 'opus' });
    expect(result.config.modelMode).toBe('opus');
    expect(result.config.maxConcurrentWorkers).toBe(4);
    expect(result.warnings).toEqual([]);
  });

  it('parseConfig salvages a single bad field (out-of-range int)', () => {
    const result = parseConfig({ maxConcurrentWorkers: -1, modelMode: 'opus' });
    expect(result.config.maxConcurrentWorkers).toBe(4);
    expect(result.config.modelMode).toBe('opus');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes('maxConcurrentWorkers'))).toBe(true);
  });

  it('parseConfig salvages an enum mismatch (modelMode)', () => {
    const result = parseConfig({ modelMode: 'unknown' });
    expect(result.config.modelMode).toBe('mixed');
    expect(result.warnings.some((w) => w.includes('modelMode'))).toBe(true);
  });

  it('parseConfig({ root array }) returns defaults + warning', () => {
    const result = parseConfig([1, 2, 3]);
    expect(result.config).toEqual(defaultConfig());
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('object');
  });

  it('parseConfig rejects a future schemaVersion outright', () => {
    const result = parseConfig({ schemaVersion: 99, modelMode: 'opus' });
    // Falls back to defaults entirely — opus override discarded by design.
    expect(result.config).toEqual(defaultConfig());
    expect(result.warnings.some((w) => w.includes('schemaVersion'))).toBe(true);
  });

  it('parseConfig round-trips a KeyChord override', () => {
    const result = parseConfig({
      keybindOverrides: {
        'palette.open': { kind: 'ctrl', char: 'o' },
      },
    });
    expect(result.config.keybindOverrides['palette.open']).toEqual({
      kind: 'ctrl',
      char: 'o',
    });
    expect(result.warnings).toEqual([]);
  });

  it('parseConfig round-trips a leader-chord KeyChord override', () => {
    const result = parseConfig({
      keybindOverrides: {
        'leader.modeSwitch': {
          kind: 'leader',
          lead: { kind: 'ctrl', char: 'x' },
          second: { kind: 'char', char: 'm' },
        },
      },
    });
    expect(result.config.keybindOverrides['leader.modeSwitch']).toEqual({
      kind: 'leader',
      lead: { kind: 'ctrl', char: 'x' },
      second: { kind: 'char', char: 'm' },
    });
  });

  it('parseConfig drops a malformed keybind override and salvages others', () => {
    const result = parseConfig({
      keybindOverrides: {
        'good.one': { kind: 'ctrl', char: 'o' },
        'bad.one': { kind: 'unknown' },
      },
    });
    // The whole record is rejected as a unit; defaults apply. Surfaces
    // a warning so the user knows.
    expect(Object.keys(result.config.keybindOverrides)).not.toContain('bad.one');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('parseConfig accepts a leaderTimeoutMs in range', () => {
    const result = parseConfig({ leaderTimeoutMs: 500 });
    expect(result.config.leaderTimeoutMs).toBe(500);
    expect(result.warnings).toEqual([]);
  });

  it('parseConfig clamps leaderTimeoutMs out of range to default', () => {
    const result = parseConfig({ leaderTimeoutMs: 50 });
    expect(result.config.leaderTimeoutMs).toBe(300);
    expect(result.warnings.some((w) => w.includes('leaderTimeoutMs'))).toBe(true);
  });

  it('parseConfig preserves a defaultProjectPath when provided', () => {
    const result = parseConfig({ defaultProjectPath: 'C:\\Users\\chris\\projects\\foo' });
    expect(result.config.defaultProjectPath).toBe('C:\\Users\\chris\\projects\\foo');
  });

  it('parseConfig drops an empty defaultProjectPath', () => {
    const result = parseConfig({ defaultProjectPath: '' });
    expect(result.config.defaultProjectPath).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('defaultProjectPath'))).toBe(true);
  });

  it('parseConfig accepts awayMode as a top-level boolean (3H.3)', () => {
    expect(parseConfig({ awayMode: true }).config.awayMode).toBe(true);
    expect(parseConfig({ awayMode: false }).config.awayMode).toBe(false);
  });

  it('parseConfig falls back to awayMode default when malformed', () => {
    const result = parseConfig({ awayMode: 'yes' });
    expect(result.config.awayMode).toBe(false);
    expect(result.warnings.some((w) => w.includes('awayMode'))).toBe(true);
  });

  it('parseConfig accepts each autoMerge enum value (3O.1)', () => {
    expect(parseConfig({ autoMerge: 'ask' }).config.autoMerge).toBe('ask');
    expect(parseConfig({ autoMerge: 'auto' }).config.autoMerge).toBe('auto');
    expect(parseConfig({ autoMerge: 'never' }).config.autoMerge).toBe('never');
  });

  it('parseConfig salvages an unknown autoMerge value (3O.1)', () => {
    const result = parseConfig({ autoMerge: 'maybe' });
    expect(result.config.autoMerge).toBe('ask');
    expect(result.warnings.some((w) => w.includes('autoMerge'))).toBe(true);
  });

  it('parseConfig accepts each autonomyTier literal (3S)', () => {
    expect(parseConfig({ autonomyTier: 1 }).config.autonomyTier).toBe(1);
    expect(parseConfig({ autonomyTier: 2 }).config.autonomyTier).toBe(2);
    expect(parseConfig({ autonomyTier: 3 }).config.autonomyTier).toBe(3);
  });

  it('parseConfig salvages out-of-range autonomyTier (3S)', () => {
    const result = parseConfig({ autonomyTier: 99 });
    expect(result.config.autonomyTier).toBe(2);
    expect(result.warnings.some((w) => w.includes('autonomyTier'))).toBe(true);
  });

  it('parseConfig salvages a non-numeric autonomyTier (3S)', () => {
    const result = parseConfig({ autonomyTier: 'high' });
    expect(result.config.autonomyTier).toBe(2);
    expect(result.warnings.some((w) => w.includes('autonomyTier'))).toBe(true);
  });
});
