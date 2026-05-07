import { describe, it, expect } from 'vitest';
import { detectKeybindConflicts } from '../../src/ui/keybinds/overrides.js';
import type {
  Command,
  CommandScope,
  KeyChord,
} from '../../src/ui/keybinds/registry.js';

const noop = (): void => {};

function cmd(
  id: string,
  key: KeyChord,
  scope: CommandScope = 'global',
): Command {
  return {
    id,
    title: id,
    key,
    scope,
    displayOnScreen: false,
    onSelect: noop,
  };
}

describe('detectKeybindConflicts', () => {
  it('returns empty when no commands collide', () => {
    const list = [
      cmd('a', { kind: 'char', char: 'a' }),
      cmd('b', { kind: 'char', char: 'b' }),
    ];
    expect(
      detectKeybindConflicts(list, 'a', { kind: 'char', char: 'X' }, 'global'),
    ).toEqual([]);
  });

  it('returns empty when candidate is none/leader', () => {
    const list = [cmd('a', { kind: 'char', char: 'X' })];
    expect(
      detectKeybindConflicts(list, 'b', { kind: 'none' }, 'global'),
    ).toEqual([]);
  });

  it('detects same-scope same-chord conflict (global)', () => {
    const list = [
      cmd('a', { kind: 'char', char: 'a' }),
      cmd('b', { kind: 'char', char: 'X' }),
    ];
    const conflicts = detectKeybindConflicts(
      list,
      'a',
      { kind: 'char', char: 'X' },
      'global',
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.id).toBe('b');
  });

  it('skips the target itself (no self-conflict)', () => {
    const list = [
      cmd('a', { kind: 'char', char: 'X' }),
      cmd('b', { kind: 'char', char: 'b' }),
    ];
    const conflicts = detectKeybindConflicts(
      list,
      'a',
      { kind: 'char', char: 'X' },
      'global',
    );
    expect(conflicts).toEqual([]);
  });

  it('skips commands with kind: "none" (palette-only)', () => {
    const list = [
      cmd('palette-only.action', { kind: 'none' }),
      cmd('a', { kind: 'char', char: 'a' }),
    ];
    const conflicts = detectKeybindConflicts(
      list,
      'a',
      { kind: 'char', char: 'X' },
      'global',
    );
    expect(conflicts).toEqual([]);
  });

  it('skips commands with kind: "leader" (leader chord registry skips dedup)', () => {
    const list = [
      cmd('leader-cmd', {
        kind: 'leader',
        lead: { kind: 'ctrl', char: 'x' },
        second: { kind: 'char', char: 'm' },
      }),
      cmd('a', { kind: 'char', char: 'a' }),
    ];
    const conflicts = detectKeybindConflicts(
      list,
      'a',
      { kind: 'ctrl', char: 'x' },
      'global',
    );
    expect(conflicts).toEqual([]);
  });

  it('global candidate collides with a specific-scope command on the same key', () => {
    const list = [cmd('chat.action', { kind: 'char', char: 'X' }, 'chat')];
    const conflicts = detectKeybindConflicts(
      list,
      'a',
      { kind: 'char', char: 'X' },
      'global',
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.id).toBe('chat.action');
  });

  it('main candidate collides with a specific-main-key command on the same key', () => {
    const list = [cmd('workers.kill', { kind: 'char', char: 'K' }, 'workers')];
    const conflicts = detectKeybindConflicts(
      list,
      'a',
      { kind: 'char', char: 'K' },
      'main',
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.id).toBe('workers.kill');
  });

  it('does NOT cross-detect different specific scopes (chat vs workers)', () => {
    const list = [cmd('chat.send', { kind: 'char', char: 'X' }, 'chat')];
    const conflicts = detectKeybindConflicts(
      list,
      'a',
      { kind: 'char', char: 'X' },
      'workers',
    );
    expect(conflicts).toEqual([]);
  });

  it('does NOT cross-detect different popup scopes (palette vs settings)', () => {
    const list = [cmd('palette.something', { kind: 'char', char: 'X' }, 'palette')];
    const conflicts = detectKeybindConflicts(
      list,
      'a',
      { kind: 'char', char: 'X' },
      'settings',
    );
    expect(conflicts).toEqual([]);
  });

  it('returns conflicts with title/scope/key for surfacing', () => {
    const list: Command[] = [
      {
        id: 'app.help',
        title: 'help',
        key: { kind: 'char', char: '?' },
        scope: 'main',
        displayOnScreen: true,
        onSelect: noop,
      },
    ];
    const conflicts = detectKeybindConflicts(
      list,
      'q.target',
      { kind: 'char', char: '?' },
      'main',
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      id: 'app.help',
      title: 'help',
      scope: 'main',
    });
  });

  it('detects multiple conflicts when candidate collides with several commands', () => {
    const list = [
      cmd('a', { kind: 'char', char: 'X' }, 'global'),
      cmd('b', { kind: 'char', char: 'X' }, 'main'),
    ];
    const conflicts = detectKeybindConflicts(
      list,
      'target',
      { kind: 'char', char: 'X' },
      'main',
    );
    expect(conflicts).toHaveLength(2);
  });
});
