import type { Command } from './registry.js';

/**
 * Default global commands seeded into `<KeybindProvider>`.
 *
 * Phase 3A: Tab/Shift+Tab focus cycling, Ctrl+C exit (delegated to
 * launcher), `?` help-stub. Per-panel commands (K/R/P for workers,
 * Enter for chat send) ship in 3B/3C.
 *
 * Phase 3E: Ctrl+Q opens the question popup. `Ctrl+Q` rather than plain
 * `q` because the chat InputBar's negative whitelist
 * (`src/ui/panels/chat/InputBar.tsx:167-184`) rejects `key.ctrl` —
 * lowercase `q` would land in the buffer when chat is focused. PLAN.md
 * `:1131`'s `Tab` was illustrative; Tab is already the focus-cycle bind.
 *
 * The command is registered globally with `disabledReason` set when no
 * questions are queued; the bottom keybind bar renders disabled commands
 * with the reason dimmed.
 *
 * Phase 3F.1: Ctrl+P opens the command palette. `?` migrates from
 * `'global'` to `'main'` scope so popup filters can capture printable
 * `?` without firing help. `Ctrl+Q` likewise migrates to `'main'` so
 * the question popup can't double-push itself. Worker selector
 * (`Ctrl+W` — the deferred 3C `/w <name>` palette item) lands at
 * `'main'` scope.
 */

export interface GlobalCommandHandlers {
  cycleFocus(): void;
  cycleFocusReverse(): void;
  /** Launcher-owned exit. Default no-op; `runTui` wires in `process.kill(SIGINT)` or similar. */
  requestExit(): void;
  showHelp(): void;
  /**
   * Phase 3F.1 — Ctrl+P pushes the command palette popup. Optional so
   * pre-3F.1 tests that built handlers without it still type-check;
   * undefined renders the palette command as no-op (still listed in the
   * keybind bar — useful for visual smoke).
   */
  openPalette?(): void;
  /** Phase 3F.1 — Ctrl+W pushes the worker-selector popup. Optional, see openPalette. */
  openWorkerSelect?(): void;
  /** Phase 3E — push the question popup. Caller wires to `focus.pushPopup('question')`. */
  openQuestions?(): void;
}

export interface GlobalCommandState {
  /** Phase 3E — total unanswered question count. Used to compute disabledReason. */
  readonly questionsCount?: number;
  /** Phase 3F.1 — total worker count. Used to disable Ctrl+W when zero. */
  readonly workersCount?: number;
}

export function buildGlobalCommands(
  handlers: GlobalCommandHandlers,
  state?: GlobalCommandState,
): readonly Command[] {
  const questionsCount = state?.questionsCount ?? 0;
  const questionsDisabled = questionsCount === 0;
  const workersCount = state?.workersCount ?? 0;
  const workersDisabled = workersCount === 0;
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
      id: 'palette.open',
      title: 'command palette',
      key: { kind: 'ctrl', char: 'p' },
      scope: 'global',
      displayOnScreen: true,
      onSelect: handlers.openPalette ?? (() => undefined),
    },
    {
      id: 'app.help',
      title: 'help',
      key: { kind: 'char', char: '?' },
      scope: 'main',
      displayOnScreen: true,
      onSelect: handlers.showHelp,
    },
    {
      id: 'questions.open',
      title: questionsCount > 0 ? `questions (${questionsCount})` : 'questions',
      key: { kind: 'ctrl', char: 'q' },
      scope: 'main',
      displayOnScreen: true,
      onSelect: handlers.openQuestions ?? (() => undefined),
      ...(questionsDisabled ? { disabledReason: 'no questions queued' } : {}),
    },
    {
      id: 'worker.select',
      title: 'select worker',
      key: { kind: 'ctrl', char: 'w' },
      scope: 'main',
      displayOnScreen: false,
      onSelect: handlers.openWorkerSelect ?? (() => undefined),
      ...(workersDisabled ? { disabledReason: 'no workers spawned' } : {}),
    },
  ];
}
