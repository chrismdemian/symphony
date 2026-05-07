import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../src/utils/config-schema.js';

/**
 * Phase 3H.4 — per-entry salvage for `keybindOverrides`.
 *
 * 3H.1's salvage loop dropped the WHOLE record on a single bad entry
 * (3H.1 m2). 3H.4 must handle each entry independently so a typo in one
 * override doesn't reset the user's other rebinds.
 */
describe('parseConfig keybindOverrides per-entry salvage', () => {
  it('keeps valid entries when one entry is malformed', () => {
    const result = parseConfig({
      keybindOverrides: {
        'app.help': { kind: 'char', char: 'F' },
        'palette.open': { kind: 'WAT' }, // bogus chord shape
      },
    });
    expect(result.config.keybindOverrides).toEqual({
      'app.help': { kind: 'char', char: 'F' },
    });
    expect(
      result.warnings.some((w) =>
        w.includes('keybindOverrides.palette.open'),
      ),
    ).toBe(true);
  });

  it('drops every entry with the wrong shape and keeps every valid one', () => {
    const result = parseConfig({
      keybindOverrides: {
        good1: { kind: 'tab' },
        bad1: 'not-an-object',
        good2: { kind: 'ctrl', char: 'k' },
        bad2: { kind: 'char' /* missing `char` */ },
        bad3: null,
      },
    });
    expect(result.config.keybindOverrides).toEqual({
      good1: { kind: 'tab' },
      good2: { kind: 'ctrl', char: 'k' },
    });
    expect(result.warnings).toHaveLength(3);
  });

  it('handles non-object keybindOverrides by replacing with empty record + warning', () => {
    const result = parseConfig({ keybindOverrides: ['oops', 'array'] });
    expect(result.config.keybindOverrides).toEqual({});
    expect(
      result.warnings.some((w) => w.includes('keybindOverrides')),
    ).toBe(true);
  });

  it('handles a string value as a hard failure with empty record', () => {
    const result = parseConfig({ keybindOverrides: 'just a string' });
    expect(result.config.keybindOverrides).toEqual({});
    expect(
      result.warnings.some((w) => w.includes('keybindOverrides')),
    ).toBe(true);
  });

  it('produces zero warnings when every entry is valid', () => {
    const result = parseConfig({
      keybindOverrides: {
        'app.help': { kind: 'char', char: 'F' },
        'palette.open': { kind: 'ctrl', char: 'p' },
      },
    });
    expect(result.warnings).toEqual([]);
    expect(result.config.keybindOverrides).toEqual({
      'app.help': { kind: 'char', char: 'F' },
      'palette.open': { kind: 'ctrl', char: 'p' },
    });
  });

  it('accepts leader chord shape in an override entry (matches schema)', () => {
    const result = parseConfig({
      keybindOverrides: {
        'leader.x': {
          kind: 'leader',
          lead: { kind: 'ctrl', char: 'x' },
          second: { kind: 'char', char: 'a' },
        },
      },
    });
    expect(result.config.keybindOverrides).toEqual({
      'leader.x': {
        kind: 'leader',
        lead: { kind: 'ctrl', char: 'x' },
        second: { kind: 'char', char: 'a' },
      },
    });
  });

  it('accepts kind: "none" override entry (palette-only command)', () => {
    const result = parseConfig({
      keybindOverrides: {
        'app.configEdit': { kind: 'none' },
      },
    });
    expect(result.config.keybindOverrides).toEqual({
      'app.configEdit': { kind: 'none' },
    });
  });

  it('warning text includes the offending command id', () => {
    const result = parseConfig({
      keybindOverrides: {
        'my.weird.id': { not: 'a chord' },
      },
    });
    const warning = result.warnings.find((w) => w.includes('my.weird.id'));
    expect(warning).toBeDefined();
    expect(warning).toContain('keybindOverrides.my.weird.id');
  });

  it('default empty record on missing field', () => {
    const result = parseConfig({});
    expect(result.config.keybindOverrides).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('preserves other fields when keybindOverrides is malformed', () => {
    const result = parseConfig({
      modelMode: 'opus',
      keybindOverrides: 'oops',
    });
    expect(result.config.modelMode).toBe('opus');
    expect(result.config.keybindOverrides).toEqual({});
  });
});
