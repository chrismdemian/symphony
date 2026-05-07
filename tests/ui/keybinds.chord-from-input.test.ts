import { describe, it, expect } from 'vitest';
import { chordFromInput } from '../../src/ui/keybinds/overrides.js';
import type { Key } from 'ink';

function k(overrides: Partial<Key> = {}): Key {
  return {
    backspace: false,
    delete: false,
    downArrow: false,
    escape: false,
    leftArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    rightArrow: false,
    shift: false,
    tab: false,
    upArrow: false,
    home: false,
    end: false,
    ctrl: false,
    meta: false,
    // Kitty-keyboard-only fields — Ink types them as required booleans
    // even though they're only populated under kitty negotiation.
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}

describe('chordFromInput', () => {
  describe('special keys', () => {
    it('captures Tab', () => {
      expect(chordFromInput('', k({ tab: true }))).toEqual({
        ok: true,
        chord: { kind: 'tab', shift: false },
      });
    });

    it('captures Shift+Tab', () => {
      expect(chordFromInput('', k({ tab: true, shift: true }))).toEqual({
        ok: true,
        chord: { kind: 'tab', shift: true },
      });
    });

    it('captures Enter', () => {
      expect(chordFromInput('', k({ return: true }))).toEqual({
        ok: true,
        chord: { kind: 'return' },
      });
    });

    it('captures arrow keys', () => {
      expect(chordFromInput('', k({ upArrow: true }))).toEqual({
        ok: true,
        chord: { kind: 'upArrow' },
      });
      expect(chordFromInput('', k({ downArrow: true }))).toEqual({
        ok: true,
        chord: { kind: 'downArrow' },
      });
      expect(chordFromInput('', k({ leftArrow: true }))).toEqual({
        ok: true,
        chord: { kind: 'leftArrow' },
      });
      expect(chordFromInput('', k({ rightArrow: true }))).toEqual({
        ok: true,
        chord: { kind: 'rightArrow' },
      });
    });

    it('captures pageUp/pageDown', () => {
      expect(chordFromInput('', k({ pageUp: true }))).toEqual({
        ok: true,
        chord: { kind: 'pageUp' },
      });
      expect(chordFromInput('', k({ pageDown: true }))).toEqual({
        ok: true,
        chord: { kind: 'pageDown' },
      });
    });
  });

  describe('Ctrl chords', () => {
    it('captures Ctrl+letter', () => {
      const result = chordFromInput('p', k({ ctrl: true }));
      expect(result).toEqual({
        ok: true,
        chord: { kind: 'ctrl', char: 'p' },
      });
    });

    it('lowercases Ctrl+<uppercase>', () => {
      const result = chordFromInput('P', k({ ctrl: true }));
      expect(result).toEqual({
        ok: true,
        chord: { kind: 'ctrl', char: 'p' },
      });
    });

    it('captures Ctrl+digit', () => {
      const result = chordFromInput('1', k({ ctrl: true }));
      expect(result).toEqual({
        ok: true,
        chord: { kind: 'ctrl', char: '1' },
      });
    });

    it('rejects Ctrl with empty input', () => {
      const result = chordFromInput('', k({ ctrl: true }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.toLowerCase()).toContain('modifier-only');
    });

    it('rejects Ctrl+space (multi-char or unsupported)', () => {
      const result = chordFromInput(' ', k({ ctrl: true }));
      expect(result.ok).toBe(false);
    });
  });

  describe('printable chars', () => {
    it('captures lowercase letter', () => {
      expect(chordFromInput('a', k())).toEqual({
        ok: true,
        chord: { kind: 'char', char: 'a' },
      });
    });

    it('captures uppercase letter (preserves case for char)', () => {
      expect(chordFromInput('F', k({ shift: true }))).toEqual({
        ok: true,
        chord: { kind: 'char', char: 'F' },
      });
    });

    it('captures punctuation', () => {
      expect(chordFromInput('?', k({ shift: true }))).toEqual({
        ok: true,
        chord: { kind: 'char', char: '?' },
      });
    });

    it('captures digit', () => {
      expect(chordFromInput('7', k())).toEqual({
        ok: true,
        chord: { kind: 'char', char: '7' },
      });
    });

    it('rejects space (reserved by SettingsPanel toggle)', () => {
      const result = chordFromInput(' ', k());
      expect(result.ok).toBe(false);
    });
  });

  describe('rejection cases', () => {
    it('rejects Shift-only', () => {
      const result = chordFromInput('', k({ shift: true }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/modifier-only/i);
    });

    it('rejects Meta/Alt chords', () => {
      const result = chordFromInput('a', k({ meta: true }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/alt|meta/i);
    });

    it('rejects multi-char paste', () => {
      const result = chordFromInput('hello', k());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/multi-character/i);
    });

    it('rejects empty input with no modifiers (impossible but defensive)', () => {
      const result = chordFromInput('', k());
      expect(result.ok).toBe(false);
    });

    it('rejects unsupported Ctrl combinations (e.g. Ctrl+special-glyph)', () => {
      // Non-ASCII printable — chord schema doesn't accept it.
      const result = chordFromInput('é', k({ ctrl: true }));
      expect(result.ok).toBe(false);
    });
  });
});
