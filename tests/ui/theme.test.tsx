import { describe, it, expect } from 'vitest';
import {
  resolveTheme,
  symphonyTheme,
  SYMPHONY_THEME,
  ThemeReferenceError,
  type ThemeJson,
} from '../../src/ui/theme/theme.js';

describe('theme resolver', () => {
  it('resolves the locked Symphony palette to all hex colors', () => {
    const theme = symphonyTheme();
    expect(theme['accent']).toBe('#7C6FEB');
    expect(theme['primary']).toBe('#D4A843');
    expect(theme['border']).toBe('#555555');
    expect(theme['text']).toBe('#E0E0E0');
    expect(theme['textMuted']).toBe('#888888');
  });

  it('exposes worker-status tokens with palette-correct colors', () => {
    const theme = symphonyTheme();
    expect(theme['workerRunning']).toBe('#7C6FEB');
    expect(theme['workerDone']).toBe('#D4A843');
    expect(theme['workerFailed']).toBe('#E06C75');
    expect(theme['workerNeedsInput']).toBe('#C678DD');
    expect(theme['workerPaused']).toBe('#888888');
  });

  it('walks ref chains via defs', () => {
    const json: ThemeJson = {
      defs: { brand: '#abcdef', text: 'brand' },
      theme: { primary: 'text' },
    };
    const t = resolveTheme(json);
    expect(t['primary']).toBe('#abcdef');
  });

  it('walks ref chains pointing into theme tokens', () => {
    const json: ThemeJson = {
      defs: {},
      theme: { primary: '#aabbcc', accent: 'primary' },
    };
    const t = resolveTheme(json);
    expect(t['accent']).toBe('#aabbcc');
  });

  it('throws ThemeReferenceError on circular reference', () => {
    const json: ThemeJson = {
      defs: { a: 'b', b: 'a' },
      theme: { primary: 'a' },
    };
    expect(() => resolveTheme(json)).toThrow(ThemeReferenceError);
    expect(() => resolveTheme(json)).toThrow(/Circular color reference/);
  });

  it('throws ThemeReferenceError on missing reference', () => {
    const json: ThemeJson = {
      defs: {},
      theme: { primary: 'nonexistent' },
    };
    expect(() => resolveTheme(json)).toThrow(ThemeReferenceError);
    expect(() => resolveTheme(json)).toThrow(/not found/);
  });

  it('returns a flat record with one entry per theme token', () => {
    const t = symphonyTheme();
    const tokens = Object.keys(SYMPHONY_THEME.theme);
    for (const k of tokens) {
      expect(t[k], `token ${k} missing`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
    expect(Object.keys(t)).toHaveLength(tokens.length);
  });
});
