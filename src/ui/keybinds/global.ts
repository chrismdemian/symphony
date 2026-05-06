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
  /**
   * Phase 3F.3 — palette-only command "View answered questions". Pushes
   * the read-only history popup. Optional during 3F transition; converts
   * to required when 3F.3 ships everywhere.
   */
  openQuestionHistory?(): void;
  /**
   * Phase 3F.2 / 3H.2 — leader-key chord toast (used for handlers
   * that don't have a real action yet, e.g. the project-switch chord
   * pending Phase 5).
   */
  showLeaderToast?(message: string): void;
  /**
   * Phase 3H.2 — `<leader>m` handler: cycle modelMode opus↔mixed,
   * persist via ConfigProvider.setConfig, and toast the new value.
   * Async because setConfig writes to disk; the keybind dispatcher's
   * useInput awaits the returned promise so an error is logged.
   */
  cycleModelMode?(): Promise<void> | void;
  /**
   * Phase 3H.2 — `<leader>t` handler: toggle theme.autoFallback16Color,
   * persist via ConfigProvider.setConfig, and toast the new value.
   */
  toggleThemeFallback?(): Promise<void> | void;
  /**
   * Phase 3H.1 — Ctrl+, opens the settings popup. Optional during 3H
   * transition; tests built before 3H.1 still type-check, undefined
   * renders the command as a no-op.
   */
  openSettings?(): void;
  /**
   * Phase 3H.1 — palette-only command "edit settings file in $EDITOR".
   * Spawns `$EDITOR` against `~/.symphony/config.json`. Optional during
   * 3H transition.
   */
  openSettingsEdit?(): void;
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
    {
      id: 'questions.viewAnswered',
      title: 'view answered questions',
      key: { kind: 'none' },
      scope: 'global',
      displayOnScreen: false,
      onSelect: handlers.openQuestionHistory ?? (() => undefined),
    },
    // Phase 3F.2 — leader-key chord stubs. Hidden from the bottom bar
    // (`displayOnScreen: false`) since the chord is wider than a normal
    // hotkey advertised in the bar — surfaced via the palette + help.
    {
      id: 'leader.modeSwitch',
      title: 'switch model mode',
      key: { kind: 'leader', lead: { kind: 'ctrl', char: 'x' }, second: { kind: 'char', char: 'm' } },
      scope: 'global',
      displayOnScreen: false,
      onSelect: () =>
        handlers.cycleModelMode?.() ??
        handlers.showLeaderToast?.('Model mode switch — handler not wired.'),
    },
    {
      id: 'leader.projectSwitch',
      title: 'switch project',
      key: { kind: 'leader', lead: { kind: 'ctrl', char: 'x' }, second: { kind: 'char', char: 'p' } },
      scope: 'global',
      displayOnScreen: false,
      onSelect: () =>
        handlers.showLeaderToast?.('Project switch — Phase 5 will wire the real action.'),
    },
    {
      id: 'leader.themeToggle',
      title: 'toggle theme',
      key: { kind: 'leader', lead: { kind: 'ctrl', char: 'x' }, second: { kind: 'char', char: 't' } },
      scope: 'global',
      displayOnScreen: false,
      onSelect: () =>
        handlers.toggleThemeFallback?.() ??
        handlers.showLeaderToast?.('Theme toggle — handler not wired.'),
    },
    // Phase 3H.1 — settings popup. Hotkey is Ctrl+, (the editor-standard
    // settings shortcut). Listed in the bottom keybind bar so it's
    // discoverable; palette also lists it via `selectAllCommands`.
    {
      id: 'app.config',
      title: 'settings',
      key: { kind: 'ctrl', char: ',' },
      scope: 'global',
      displayOnScreen: true,
      onSelect: handlers.openSettings ?? (() => undefined),
    },
    // Phase 3H.1 — palette-only command for opening the file in $EDITOR.
    // `kind: 'none'` = no global hotkey, palette-invokable only. The
    // 3F.3 audit C2 path through `selectCommands` skips dedup for
    // 'none'-kind commands so this coexists with `app.config` cleanly.
    {
      id: 'app.configEdit',
      title: 'edit settings file in $EDITOR',
      key: { kind: 'none' },
      scope: 'global',
      displayOnScreen: false,
      onSelect: handlers.openSettingsEdit ?? (() => undefined),
    },
  ];
}
