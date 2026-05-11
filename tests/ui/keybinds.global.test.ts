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
  it('emits the questions.open command at scope main with Ctrl+Q (3F.1)', () => {
    const cmds = buildGlobalCommands(handlers);
    const q = cmds.find((c) => c.id === 'questions.open');
    expect(q).toBeDefined();
    // Phase 3F.1: scope migrated from 'global' to 'main' so popup
    // filters can capture printable Ctrl+Q without re-pushing the
    // question popup over a palette/help overlay.
    expect(q?.scope).toBe('main');
    expect(q?.key).toEqual({ kind: 'ctrl', char: 'q' });
    expect(q?.displayOnScreen).toBe(true);
  });

  it('emits the palette.open command at scope global with Ctrl+P (3F.1)', () => {
    const cmds = buildGlobalCommands(handlers);
    const p = cmds.find((c) => c.id === 'palette.open');
    expect(p).toBeDefined();
    expect(p?.scope).toBe('global');
    expect(p?.key).toEqual({ kind: 'ctrl', char: 'p' });
    expect(p?.displayOnScreen).toBe(true);
  });

  it('emits the worker.select command at scope main with Ctrl+W (3F.1)', () => {
    const cmds = buildGlobalCommands(handlers);
    const w = cmds.find((c) => c.id === 'worker.select');
    expect(w).toBeDefined();
    expect(w?.scope).toBe('main');
    expect(w?.key).toEqual({ kind: 'ctrl', char: 'w' });
    // Hidden from the bottom bar; surfaced via palette.
    expect(w?.displayOnScreen).toBe(false);
  });

  it('disables the worker.select command when no workers (3F.1)', () => {
    const cmds = buildGlobalCommands(handlers, { workersCount: 0 });
    const w = cmds.find((c) => c.id === 'worker.select');
    expect(w?.disabledReason).toBe('no workers spawned');
  });

  it('enables the worker.select command when workers exist (3F.1)', () => {
    const cmds = buildGlobalCommands(handlers, { workersCount: 2 });
    const w = cmds.find((c) => c.id === 'worker.select');
    expect(w?.disabledReason).toBeUndefined();
  });

  it('emits the app.help command at scope main (3F.1)', () => {
    const cmds = buildGlobalCommands(handlers);
    const h = cmds.find((c) => c.id === 'app.help');
    expect(h).toBeDefined();
    expect(h?.scope).toBe('main');
    expect(h?.key).toEqual({ kind: 'char', char: '?' });
  });

  it('invokes openPalette handler when present', () => {
    const open = vi.fn();
    const cmds = buildGlobalCommands({ ...handlers, openPalette: open });
    const p = cmds.find((c) => c.id === 'palette.open');
    p!.onSelect();
    expect(open).toHaveBeenCalledOnce();
  });

  it('invokes openWorkerSelect handler when present', () => {
    const open = vi.fn();
    const cmds = buildGlobalCommands(
      { ...handlers, openWorkerSelect: open },
      { workersCount: 1 },
    );
    const w = cmds.find((c) => c.id === 'worker.select');
    w!.onSelect();
    expect(open).toHaveBeenCalledOnce();
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

  // ── Phase 3H.1 ─────────────────────────────────────────────────────────
  it('emits app.config at scope global with Ctrl+, (3H.1)', () => {
    const cmds = buildGlobalCommands(handlers);
    const c = cmds.find((cmd) => cmd.id === 'app.config');
    expect(c).toBeDefined();
    expect(c?.scope).toBe('global');
    expect(c?.key).toEqual({ kind: 'ctrl', char: ',' });
    expect(c?.displayOnScreen).toBe(true);
    expect(c?.title).toBe('settings');
  });

  it('emits app.configEdit as palette-only with kind:none (3H.1)', () => {
    const cmds = buildGlobalCommands(handlers);
    const e = cmds.find((cmd) => cmd.id === 'app.configEdit');
    expect(e).toBeDefined();
    expect(e?.key).toEqual({ kind: 'none' });
    // displayOnScreen=false: hidden from the bottom bar (palette-only).
    expect(e?.displayOnScreen).toBe(false);
  });

  it('app.config and app.configEdit coexist without conflicting (3H.1, 3F.3 C2)', () => {
    // selectCommands skips dedup for 'none'-kind commands; the registry
    // accepts both app.config (Ctrl+,) and app.configEdit (none-kind)
    // at the same scope without DuplicateKeybindError.
    const cmds = buildGlobalCommands(handlers);
    const c = cmds.find((cmd) => cmd.id === 'app.config');
    const e = cmds.find((cmd) => cmd.id === 'app.configEdit');
    expect(c).toBeDefined();
    expect(e).toBeDefined();
  });

  it('invokes openSettings handler when present (3H.1)', () => {
    const open = vi.fn();
    const cmds = buildGlobalCommands({ ...handlers, openSettings: open });
    const c = cmds.find((cmd) => cmd.id === 'app.config');
    c!.onSelect();
    expect(open).toHaveBeenCalledOnce();
  });

  it('invokes openSettingsEdit handler when present (3H.1)', () => {
    const open = vi.fn();
    const cmds = buildGlobalCommands({ ...handlers, openSettingsEdit: open });
    const e = cmds.find((cmd) => cmd.id === 'app.configEdit');
    e!.onSelect();
    expect(open).toHaveBeenCalledOnce();
  });

  it('app.config without openSettings handler is a no-op (3H.1)', () => {
    const cmds = buildGlobalCommands(handlers);
    const c = cmds.find((cmd) => cmd.id === 'app.config');
    expect(() => c!.onSelect()).not.toThrow();
  });

  it('invokes cycleModelMode for `<leader>m` when wired (3H.2)', () => {
    const cycle = vi.fn();
    const cmds = buildGlobalCommands({ ...handlers, cycleModelMode: cycle });
    const m = cmds.find((cmd) => cmd.id === 'leader.modeSwitch');
    m!.onSelect();
    expect(cycle).toHaveBeenCalledOnce();
  });

  it('invokes toggleThemeFallback for `<leader>t` when wired (3H.2)', () => {
    const toggle = vi.fn();
    const cmds = buildGlobalCommands({ ...handlers, toggleThemeFallback: toggle });
    const t = cmds.find((cmd) => cmd.id === 'leader.themeToggle');
    t!.onSelect();
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('falls back to showLeaderToast when leader handlers are unwired (3H.2)', () => {
    const toast = vi.fn();
    const cmds = buildGlobalCommands({ ...handlers, showLeaderToast: toast });
    const m = cmds.find((cmd) => cmd.id === 'leader.modeSwitch');
    m!.onSelect();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Model mode switch'));
    const t = cmds.find((cmd) => cmd.id === 'leader.themeToggle');
    t!.onSelect();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Theme toggle'));
  });

  // ── Phase 3M ───────────────────────────────────────────────────────────
  it('emits leader.awayToggle bound to Ctrl+X a (3M)', () => {
    const cmds = buildGlobalCommands(handlers);
    const a = cmds.find((cmd) => cmd.id === 'leader.awayToggle');
    expect(a).toBeDefined();
    expect(a?.scope).toBe('global');
    expect(a?.key).toEqual({
      kind: 'leader',
      lead: { kind: 'ctrl', char: 'x' },
      second: { kind: 'char', char: 'a' },
    });
    expect(a?.displayOnScreen).toBe(false);
    expect(a?.title).toBe('toggle away mode');
  });

  it('invokes toggleAwayMode for `<leader>a` when wired (3M)', () => {
    const toggle = vi.fn();
    const cmds = buildGlobalCommands({ ...handlers, toggleAwayMode: toggle });
    const a = cmds.find((cmd) => cmd.id === 'leader.awayToggle');
    a!.onSelect();
    expect(toggle).toHaveBeenCalledOnce();
  });

  it('falls back to showLeaderToast for `<leader>a` when handler unwired (3M)', () => {
    const toast = vi.fn();
    const cmds = buildGlobalCommands({ ...handlers, showLeaderToast: toast });
    const a = cmds.find((cmd) => cmd.id === 'leader.awayToggle');
    a!.onSelect();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Away mode toggle'));
  });
});
