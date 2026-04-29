import type { Command } from './registry.js';

/**
 * Default global commands seeded into `<KeybindProvider>`.
 *
 * Phase 3A: Tab/Shift+Tab focus cycling, Ctrl+C exit (delegated to
 * launcher), `?` help-stub. Per-panel commands (K/R/P for workers,
 * Enter for chat send) ship in 3B/3C.
 */

export interface GlobalCommandHandlers {
  cycleFocus(): void;
  cycleFocusReverse(): void;
  /** Launcher-owned exit. Default no-op; `runTui` wires in `process.kill(SIGINT)` or similar. */
  requestExit(): void;
  showHelp(): void;
}

export function buildGlobalCommands(handlers: GlobalCommandHandlers): readonly Command[] {
  return [
    {
      id: 'focus.cycle',
      title: 'next panel',
      key: { kind: 'tab' },
      scope: 'global',
      displayOnScreen: true,
      onSelect: handlers.cycleFocus,
    },
    {
      id: 'focus.cycleReverse',
      title: 'prev panel',
      key: { kind: 'tab', shift: true },
      scope: 'global',
      displayOnScreen: false,
      onSelect: handlers.cycleFocusReverse,
    },
    {
      id: 'app.exit',
      title: 'exit',
      key: { kind: 'ctrl', char: 'c' },
      scope: 'global',
      displayOnScreen: true,
      onSelect: handlers.requestExit,
    },
    {
      id: 'app.help',
      title: 'help',
      key: { kind: 'char', char: '?' },
      scope: 'global',
      displayOnScreen: true,
      onSelect: handlers.showHelp,
    },
  ];
}
