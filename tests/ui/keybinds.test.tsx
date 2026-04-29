import { describe, it, expect } from 'vitest';
import {
  formatKey,
  formatBindings,
  selectCommands,
  DuplicateKeybindError,
  type Command,
} from '../../src/ui/keybinds/registry.js';

const noop = (): void => {};

describe('formatKey', () => {
  it('formats Tab', () => {
    expect(formatKey({ kind: 'tab' })).toBe('Tab');
  });
  it('formats Shift+Tab', () => {
    expect(formatKey({ kind: 'tab', shift: true })).toBe('Shift+Tab');
  });
  it('formats Ctrl+C', () => {
    expect(formatKey({ kind: 'ctrl', char: 'c' })).toBe('Ctrl+C');
  });
  it('formats arrow keys with arrows', () => {
    expect(formatKey({ kind: 'leftArrow' })).toBe('←');
    expect(formatKey({ kind: 'rightArrow' })).toBe('→');
  });
  it('formats char chord verbatim', () => {
    expect(formatKey({ kind: 'char', char: '?' })).toBe('?');
  });
});

describe('selectCommands', () => {
  const a: Command = {
    id: 'g.tab',
    title: 'next',
    key: { kind: 'tab' },
    scope: 'global',
    displayOnScreen: true,
    onSelect: noop,
  };
  const b: Command = {
    id: 'chat.tab',
    title: 'chat tab',
    key: { kind: 'tab' },
    scope: 'chat',
    displayOnScreen: true,
    onSelect: noop,
  };
  const c: Command = {
    id: 'g.exit',
    title: 'exit',
    key: { kind: 'ctrl', char: 'c' },
    scope: 'global',
    displayOnScreen: true,
    onSelect: noop,
  };
  const d: Command = {
    id: 'g.hidden',
    title: 'hidden',
    key: { kind: 'char', char: 'x' },
    scope: 'global',
    displayOnScreen: false,
    onSelect: noop,
  };

  it('returns global commands when scope has no override', () => {
    const out = selectCommands([a, c], 'workers', false);
    expect(out.map((c) => c.id)).toContain('g.tab');
    expect(out.map((c) => c.id)).toContain('g.exit');
  });

  it('panel scope overrides global on the same key', () => {
    const out = selectCommands([a, b], 'chat', false);
    const tabCmd = out.find((c) => formatKey(c.key) === 'Tab');
    expect(tabCmd?.id).toBe('chat.tab');
  });

  it('drops out-of-scope panel commands', () => {
    const out = selectCommands([a, b], 'workers', false);
    const ids = out.map((c) => c.id);
    expect(ids).toContain('g.tab');
    expect(ids).not.toContain('chat.tab');
  });

  it('forBar=true filters out displayOnScreen=false', () => {
    const all = selectCommands([a, c, d], 'global', false);
    const bar = selectCommands([a, c, d], 'global', true);
    expect(all.map((c) => c.id)).toContain('g.hidden');
    expect(bar.map((c) => c.id)).not.toContain('g.hidden');
  });

  it('global commands appear regardless of focus scope', () => {
    const out = selectCommands([c], 'output', true);
    expect(out.map((c) => c.id)).toContain('g.exit');
  });

  it('throws DuplicateKeybindError on same-scope same-key conflict (audit M3)', () => {
    const x: Command = {
      id: 'chat.tab.a',
      title: 'first',
      key: { kind: 'tab' },
      scope: 'chat',
      displayOnScreen: true,
      onSelect: noop,
    };
    const y: Command = {
      id: 'chat.tab.b',
      title: 'second',
      key: { kind: 'tab' },
      scope: 'chat',
      displayOnScreen: true,
      onSelect: noop,
    };
    expect(() => selectCommands([x, y], 'chat', false)).toThrow(DuplicateKeybindError);
    expect(() => selectCommands([x, y], 'chat', false)).toThrow(/Duplicate keybind/);
  });

  it('does NOT throw when same-key commands are at different scopes', () => {
    const chat: Command = {
      id: 'chat.tab',
      title: 'chat',
      key: { kind: 'tab' },
      scope: 'chat',
      displayOnScreen: true,
      onSelect: noop,
    };
    const workers: Command = {
      id: 'workers.tab',
      title: 'workers',
      key: { kind: 'tab' },
      scope: 'workers',
      displayOnScreen: true,
      onSelect: noop,
    };
    // Selecting in 'chat' scope only sees chat.tab — no conflict.
    expect(() => selectCommands([chat, workers], 'chat', false)).not.toThrow();
  });
});

describe('formatBindings', () => {
  const make = (id: string, title: string, key: 'Tab' | 'Esc' | 'Ctrl+C' | '?'): Command => {
    const k =
      key === 'Tab'
        ? ({ kind: 'tab' } as const)
        : key === 'Esc'
          ? ({ kind: 'escape' } as const)
          : key === 'Ctrl+C'
            ? ({ kind: 'ctrl', char: 'c' } as const)
            : ({ kind: 'char', char: '?' } as const);
    return { id, title, key: k, scope: 'global', displayOnScreen: true, onSelect: noop };
  };

  it('joins commands with double-space separator', () => {
    const cmds = [make('a', 'next', 'Tab'), make('b', 'exit', 'Ctrl+C')];
    expect(formatBindings(cmds, 80)).toBe('Tab: next  Ctrl+C: exit');
  });

  it('returns empty string for empty list', () => {
    expect(formatBindings([], 80)).toBe('');
  });

  it('truncates with ellipsis when overflow', () => {
    const cmds = [
      make('a', 'next panel', 'Tab'),
      make('b', 'exit application', 'Ctrl+C'),
      make('c', 'help overlay', '?'),
    ];
    const out = formatBindings(cmds, 25);
    expect(out).toMatch(/…$/);
    expect(out.length).toBeLessThanOrEqual(25);
  });

  it('shows only ellipsis when even the first piece does not fit', () => {
    const cmds = [make('a', 'this is a very long title that will not fit', 'Tab')];
    const out = formatBindings(cmds, 10);
    expect(out).toMatch(/…$/);
  });
});
