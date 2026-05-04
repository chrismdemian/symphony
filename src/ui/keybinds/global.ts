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
 */

export interface GlobalCommandHandlers {
  cycleFocus(): void;
  cycleFocusReverse(): void;
  /** Launcher-owned exit. Default no-op; `runTui` wires in `process.kill(SIGINT)` or similar. */
  requestExit(): void;
  showHelp(): void;
  /** Phase 3E — push the question popup. Caller wires to `focus.pushPopup('question')`. */
  openQuestions?(): void;
}

export interface GlobalCommandState {
  /** Phase 3E — total unanswered question count. Used to compute disabledReason. */
  readonly questionsCount?: number;
}

export function buildGlobalCommands(
  handlers: GlobalCommandHandlers,
  state?: GlobalCommandState,
): readonly Command[] {
  const questionsCount = state?.questionsCount ?? 0;
  const questionsDisabled = questionsCount === 0;
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
    {
      id: 'questions.open',
      title: questionsCount > 0 ? `questions (${questionsCount})` : 'questions',
      key: { kind: 'ctrl', char: 'q' },
      scope: 'global',
      displayOnScreen: true,
      onSelect: handlers.openQuestions ?? (() => undefined),
      ...(questionsDisabled ? { disabledReason: 'no questions queued' } : {}),
    },
  ];
}
