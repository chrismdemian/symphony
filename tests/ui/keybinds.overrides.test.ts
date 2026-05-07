import { describe, it, expect } from 'vitest';
import {
  applyKeybindOverrides,
  withOverride,
  withoutOverride,
  describeChord,
} from '../../src/ui/keybinds/overrides.js';
import type { Command, KeyChord } from '../../src/ui/keybinds/registry.js';

const noop = (): void => {};

function cmd(id: string, key: KeyChord, internal = false): Command {
  return {
    id,
    title: id,
    key,
    scope: 'global',
    displayOnScreen: false,
    onSelect: noop,
    ...(internal ? { internal: true } : {}),
  };
}

describe('applyKeybindOverrides', () => {
  it('returns identity when overrides is empty', () => {
    const list = [cmd('a', { kind: 'char', char: 'a' })];
    expect(applyKeybindOverrides(list, {})).toBe(list);
  });

  it('returns identity when no override id matches any command id', () => {
    const list = [cmd('a', { kind: 'char', char: 'a' })];
    const overrides = { 'b.unknown': { kind: 'char' as const, char: 'x' } };
    expect(applyKeybindOverrides(list, overrides)).toBe(list);
  });

  it('replaces key when override matches', () => {
    const list = [cmd('a', { kind: 'char', char: 'a' })];
    const overrides = { a: { kind: 'char' as const, char: 'X' } };
    const result = applyKeybindOverrides(list, overrides);
    expect(result).not.toBe(list);
    expect(result[0]?.key).toEqual({ kind: 'char', char: 'X' });
  });

  it('preserves unrelated commands in the same list', () => {
    const list = [
      cmd('a', { kind: 'char', char: 'a' }),
      cmd('b', { kind: 'char', char: 'b' }),
    ];
    const overrides = { a: { kind: 'char' as const, char: 'X' } };
    const result = applyKeybindOverrides(list, overrides);
    expect(result[0]?.key).toEqual({ kind: 'char', char: 'X' });
    expect(result[1]).toBe(list[1]);
  });

  it('NEVER overrides internal commands (popup-internal nav is sacred)', () => {
    const list = [
      cmd('palette.dismiss', { kind: 'escape' }, true),
      cmd('app.help', { kind: 'char', char: '?' }),
    ];
    const overrides = {
      'palette.dismiss': { kind: 'char' as const, char: 'q' },
      'app.help': { kind: 'char' as const, char: 'F' },
    };
    const result = applyKeybindOverrides(list, overrides);
    // internal command unchanged
    expect(result[0]?.key).toEqual({ kind: 'escape' });
    // non-internal overridden
    expect(result[1]?.key).toEqual({ kind: 'char', char: 'F' });
  });

  it('NEVER overrides unbindable commands (Ctrl+C / Tab / Shift+Tab)', () => {
    const list: Command[] = [
      {
        ...cmd('app.exit', { kind: 'ctrl', char: 'c' }),
        unbindable: true,
      },
      {
        ...cmd('focus.cycle', { kind: 'tab' }),
        unbindable: true,
      },
      cmd('app.help', { kind: 'char', char: '?' }),
    ];
    const overrides = {
      'app.exit': { kind: 'char' as const, char: 'q' },
      'focus.cycle': { kind: 'char' as const, char: 't' },
      'app.help': { kind: 'char' as const, char: 'F' },
    };
    const result = applyKeybindOverrides(list, overrides);
    // unbindable commands keep their original chord even when an
    // override entry targets them (defense-in-depth).
    expect(result[0]?.key).toEqual({ kind: 'ctrl', char: 'c' });
    expect(result[1]?.key).toEqual({ kind: 'tab' });
    expect(result[2]?.key).toEqual({ kind: 'char', char: 'F' });
  });

  it('preserves all other Command fields when overriding', () => {
    const original = {
      ...cmd('a', { kind: 'char', char: 'a' }),
      title: 'Test action',
      disabledReason: 'because',
      displayOnScreen: true,
    };
    const overrides = { a: { kind: 'tab' as const } };
    const result = applyKeybindOverrides([original], overrides);
    expect(result[0]?.title).toBe('Test action');
    expect(result[0]?.disabledReason).toBe('because');
    expect(result[0]?.displayOnScreen).toBe(true);
    expect(result[0]?.key).toEqual({ kind: 'tab' });
  });

  it('handles multiple overrides applied in one pass', () => {
    const list = [
      cmd('a', { kind: 'char', char: 'a' }),
      cmd('b', { kind: 'char', char: 'b' }),
      cmd('c', { kind: 'char', char: 'c' }),
    ];
    const overrides = {
      a: { kind: 'tab' as const },
      c: { kind: 'escape' as const },
    };
    const result = applyKeybindOverrides(list, overrides);
    expect(result[0]?.key).toEqual({ kind: 'tab' });
    expect(result[1]).toBe(list[1]);
    expect(result[2]?.key).toEqual({ kind: 'escape' });
  });
});

describe('withOverride', () => {
  it('adds a new override entry without mutating the input', () => {
    const before = { x: { kind: 'char' as const, char: 'x' } };
    const after = withOverride(before, 'y', { kind: 'tab' });
    expect(before).toEqual({ x: { kind: 'char', char: 'x' } });
    expect(after).toEqual({
      x: { kind: 'char', char: 'x' },
      y: { kind: 'tab' },
    });
  });

  it('replaces an existing override entry', () => {
    const before = { x: { kind: 'char' as const, char: 'x' } };
    const after = withOverride(before, 'x', { kind: 'tab' });
    expect(after).toEqual({ x: { kind: 'tab' } });
  });
});

describe('withoutOverride', () => {
  it('returns identity when id not present', () => {
    const before = { x: { kind: 'char' as const, char: 'x' } };
    expect(withoutOverride(before, 'y')).toBe(before);
  });

  it('drops the entry without mutating the input', () => {
    const before = {
      x: { kind: 'char' as const, char: 'x' },
      y: { kind: 'tab' as const },
    };
    const after = withoutOverride(before, 'x');
    expect(before).toEqual({
      x: { kind: 'char', char: 'x' },
      y: { kind: 'tab' },
    });
    expect(after).toEqual({ y: { kind: 'tab' } });
  });
});

describe('describeChord', () => {
  it('formats normal chords via formatKey', () => {
    expect(describeChord({ kind: 'tab' })).toBe('Tab');
    expect(describeChord({ kind: 'ctrl', char: 'p' })).toBe('Ctrl+P');
  });
  it('returns "(none)" for `kind: none` chords', () => {
    expect(describeChord({ kind: 'none' })).toBe('(none)');
  });
});
