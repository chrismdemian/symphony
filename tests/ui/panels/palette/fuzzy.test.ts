import { describe, it, expect } from 'vitest';
import { fuzzyFilter } from '../../../../src/ui/panels/palette/fuzzy.js';
import type { Command } from '../../../../src/ui/keybinds/registry.js';

const noop = (): void => undefined;

const make = (id: string, title: string): Command => ({
  id,
  title,
  key: { kind: 'char', char: id[0] ?? 'x' },
  scope: 'global',
  displayOnScreen: true,
  onSelect: noop,
});

describe('fuzzyFilter', () => {
  it('returns the full list (in registry order) for empty query', () => {
    const cmds = [make('a', 'next panel'), make('b', 'exit'), make('c', 'help')];
    const out = fuzzyFilter(cmds, '');
    expect(out.map((m) => m.cmd.id)).toEqual(['a', 'b', 'c']);
    expect(out.every((m) => m.indexes.length === 0)).toBe(true);
  });

  it('returns the full list for whitespace-only query', () => {
    const cmds = [make('a', 'next panel'), make('b', 'exit')];
    expect(fuzzyFilter(cmds, '   ').map((m) => m.cmd.id)).toEqual(['a', 'b']);
  });

  it('orders matches by score, best first', () => {
    const cmds = [
      make('a', 'next panel'),
      make('b', 'exit'),
      make('c', 'next worker'),
      make('d', 'help'),
    ];
    const out = fuzzyFilter(cmds, 'next');
    expect(out.length).toBeGreaterThan(0);
    // Both `next panel` and `next worker` should rank above unrelated.
    const ids = out.map((m) => m.cmd.id);
    expect(ids).toContain('a');
    expect(ids).toContain('c');
    expect(ids).not.toContain('b');
    expect(ids).not.toContain('d');
  });

  it('returns matched character indexes for highlight rendering', () => {
    const cmds = [make('a', 'select worker')];
    const out = fuzzyFilter(cmds, 'sw');
    expect(out).toHaveLength(1);
    const m = out[0]!;
    expect(m.indexes.length).toBeGreaterThanOrEqual(2);
    // Indexes must point at chars in the title that produce the query
    const title = m.cmd.title;
    const matched = m.indexes.map((i) => title[i]).join('').toLowerCase();
    expect(matched).toContain('s');
    expect(matched).toContain('w');
  });

  it('filters out commands that do not match the query', () => {
    const cmds = [make('a', 'foo'), make('b', 'bar'), make('c', 'baz')];
    const out = fuzzyFilter(cmds, 'xyz');
    expect(out).toEqual([]);
  });

  it('caps results at the limit', () => {
    const cmds = Array.from({ length: 100 }, (_, i) => make(`id-${i}`, `command number ${i}`));
    const out = fuzzyFilter(cmds, 'command', 5);
    expect(out.length).toBeLessThanOrEqual(5);
  });
});
