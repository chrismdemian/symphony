import { describe, it, expect, vi } from 'vitest';
import { buildGlobalCommands } from '../../src/ui/keybinds/global.js';

/**
 * Phase 3E — `buildGlobalCommands` now takes a state argument that
 * controls the `questions.open` command's `disabledReason`. This file
 * pins that contract; the existing keybinds.test.tsx covers the rest of
 * the registry behavior.
 */

const handlers = {
  cycleFocus: vi.fn(),
  cycleFocusReverse: vi.fn(),
  requestExit: vi.fn(),
  showHelp: vi.fn(),
  openQuestions: vi.fn(),
};

describe('buildGlobalCommands', () => {
  it('always emits the questions.open command at scope global with Ctrl+Q', () => {
    const cmds = buildGlobalCommands(handlers);
    const q = cmds.find((c) => c.id === 'questions.open');
    expect(q).toBeDefined();
    expect(q?.scope).toBe('global');
    expect(q?.key).toEqual({ kind: 'ctrl', char: 'q' });
    expect(q?.displayOnScreen).toBe(true);
  });

  it('disables the questions command with reason when count is 0', () => {
    const cmds = buildGlobalCommands(handlers, { questionsCount: 0 });
    const q = cmds.find((c) => c.id === 'questions.open');
    expect(q?.disabledReason).toBe('no questions queued');
    expect(q?.title).toBe('questions');
  });

  it('enables the questions command and embeds count in title when count > 0', () => {
    const cmds = buildGlobalCommands(handlers, { questionsCount: 3 });
    const q = cmds.find((c) => c.id === 'questions.open');
    expect(q?.disabledReason).toBeUndefined();
    expect(q?.title).toBe('questions (3)');
  });

  it('omitting handler still produces a runnable onSelect (no-op)', () => {
    const cmds = buildGlobalCommands({
      cycleFocus: vi.fn(),
      cycleFocusReverse: vi.fn(),
      requestExit: vi.fn(),
      showHelp: vi.fn(),
    });
    const q = cmds.find((c) => c.id === 'questions.open');
    expect(q).toBeDefined();
    // Should not throw when invoked.
    expect(() => q!.onSelect()).not.toThrow();
  });

  it('invokes openQuestions handler when present', () => {
    const open = vi.fn();
    const cmds = buildGlobalCommands(
      { ...handlers, openQuestions: open },
      { questionsCount: 1 },
    );
    const q = cmds.find((c) => c.id === 'questions.open');
    q!.onSelect();
    expect(open).toHaveBeenCalledOnce();
  });
});
