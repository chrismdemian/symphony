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
  /**
   * Phase 3H.4 — palette-only command "edit keybinds". Pushes the
   * keybind-list popup onto the focus stack. Optional during 3H
   * transition.
   */
  openKeybindEditor?(): void;
  /**
   * Phase 3H.4 — palette-only command "reset keybind". Pushes the
   * keybind-list popup; the user picks a row and presses `r` to reset
   * its override. We don't auto-pick a target — the editor IS the
   * picker. Optional during 3H transition.
   */
  openKeybindReset?(): void;
  /**
   * Phase 3M — `<leader>a` chord toggles `config.awayMode`. Async because
   * the handler:
   *   1. Calls `runtime.setAwayMode` RPC (server dispatch context flips
   *      BEFORE the disk write so the capability shim sees the new value
   *      first; see audit M2 on commit 1).
   *   2. Persists via `setConfig`.
   *   3. On the true→false edge, flushes the digest + pushes a system
   *      row.
   * Optional during 3M transition; falls back to a toast when omitted.
   */
  toggleAwayMode?(): Promise<void> | void;
  /**
   * Phase 3N.3 — `/stats` slash + `app.openStats` palette entry push
   * the stats popup. Optional during 3N transition.
   */
  openStats?(): void;
  /**
   * Phase 3P — `/deps` slash + `app.openDeps` palette entry push the
   * dep-graph popup. Optional during 3P transition.
   */
  openDeps?(): void;
  /**
   * Phase 3S — Ctrl+Y cycles the global autonomy tier (1 → 2 → 3 → 1).
   * Calls `setConfig` with a function-patch (race-safe per 3H.2 audit
   * C2), surfaces a toast naming the new tier, and the AppShell's
   * autonomyTier useEffect propagates the new value into the server's
   * dispatch context via `runtime.setAutonomyTier`.
   *
   * Scope is `'global'` (not `'main'`) so the chord fires from inside
   * popups too — the user may want to dial autonomy down while reading
   * the help overlay or composing a Mission Control inject.
   *
   * Optional during 3S transition; falls back to a toast when omitted.
   */
  cycleAutonomyTier?(): Promise<void> | void;
  /**
   * Phase 3T — Esc during Maestro streaming = pivot signal. Handler:
   *   - calls `rpc.call.runtime.interrupt()`
   *   - calls `data.markInterrupted(result)` (chat row + envelope arm)
   *   - shows a toast on RPC failure
   *
   * Optional during 3T transition; falls back to a toast when omitted.
   */
  pivotInterruptEsc?(): Promise<void> | void;
  /**
   * Phase 3T — Ctrl+C during Maestro streaming = pivot signal. Same as
   * `pivotInterruptEsc`, but with two-tap escape hatch: a second Ctrl+C
   * within 2s of the first calls `handlers.requestExit()` so the user
   * never loses the kill switch. The handler implementation in
   * AppShell tracks the timer.
   */
  pivotInterruptCtrlC?(): Promise<void> | void;
}

export interface GlobalCommandState {
  /** Phase 3E — total unanswered question count. Used to compute disabledReason. */
  readonly questionsCount?: number;
  /** Phase 3F.1 — total worker count. Used to disable Ctrl+W when zero. */
  readonly workersCount?: number;
  /**
   * Phase 3T — combined gate for `app.interrupt`. The command is enabled
   * when ANY of these is true:
   *   - Maestro's turn is in flight
   *   - There are running workers
   *   - There are pending tasks or queued spawns
   *
   * When all are false the command is disabled — Ctrl+C then falls
   * through to `app.exit` (per dispatcher.tsx:247) and Esc no-ops.
   */
  readonly pivotEligible?: boolean;
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
    // Phase 3H.4: Tab focus-cycle and Ctrl+C exit are flagged
    // `unbindable: true` so the override editor refuses to rebind
    // them. Rebinding Tab would brick panel navigation; rebinding
    // Ctrl+C would brick the only launcher kill switch. They remain
    // visible in the editor list for awareness but Enter on the row
    // toasts a deferred message rather than entering capture mode.
    {
      id: 'focus.cycle',
      title: 'next panel',
      key: { kind: 'tab' },
      scope: 'global',
      displayOnScreen: true,
      onSelect: handlers.cycleFocus,
      unbindable: true,
    },
    {
      id: 'focus.cycleReverse',
      title: 'prev panel',
      key: { kind: 'tab', shift: true },
      scope: 'global',
      displayOnScreen: false,
      onSelect: handlers.cycleFocusReverse,
      unbindable: true,
    },
    {
      id: 'app.exit',
      title: 'exit',
      key: { kind: 'ctrl', char: 'c' },
      scope: 'global',
      displayOnScreen: true,
      onSelect: handlers.requestExit,
      unbindable: true,
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
    // Phase 3M — `<leader>a` (Ctrl+X a) flips Away Mode. Same chord
    // shape as the other leaders so the WhichKey hint surfaces it
    // alongside `m` / `p` / `t` when Ctrl+X is armed.
    {
      id: 'leader.awayToggle',
      title: 'toggle away mode',
      key: { kind: 'leader', lead: { kind: 'ctrl', char: 'x' }, second: { kind: 'char', char: 'a' } },
      scope: 'global',
      displayOnScreen: false,
      onSelect: () =>
        handlers.toggleAwayMode?.() ??
        handlers.showLeaderToast?.('Away mode toggle — handler not wired.'),
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
    // Phase 3H.4 — palette-only entry into the keybind editor. The
    // editor's own row-Enter is the chord-capture entry point; this
    // command is the discovery surface for users browsing the palette.
    // `displayOnScreen: false` keeps the bottom keybind bar uncluttered.
    {
      id: 'keybinds.open',
      title: 'edit keybinds',
      key: { kind: 'none' },
      scope: 'global',
      displayOnScreen: false,
      onSelect: handlers.openKeybindEditor ?? (() => undefined),
    },
    // Phase 3H.4 — palette-only "reset a keybind". Routes to the same
    // editor popup; the user picks the target row and presses `r`. A
    // separate "reset all" surface is intentionally not exposed — the
    // schema-default is recoverable by deleting `keybindOverrides`
    // from `~/.symphony/config.json` directly.
    {
      id: 'keybinds.reset',
      title: 'reset a keybind',
      key: { kind: 'none' },
      scope: 'global',
      displayOnScreen: false,
      onSelect: handlers.openKeybindReset ?? (() => undefined),
    },
    // Phase 3N.3 — palette-only entry into the stats popup. No hotkey
    // (kind: 'none') — `/stats` slash is the keystroke surface. Listed
    // in the palette so users browsing for "tokens"/"cost"/"stats"
    // find the popup without memorizing the slash.
    {
      id: 'app.stats',
      title: 'show session stats',
      key: { kind: 'none' },
      scope: 'global',
      displayOnScreen: false,
      onSelect: handlers.openStats ?? (() => undefined),
    },
    // Phase 3P — palette-only entry into the dep-graph popup. No hotkey;
    // `/deps` slash is the keystroke surface.
    {
      id: 'app.deps',
      title: 'show task dep graph',
      key: { kind: 'none' },
      scope: 'global',
      displayOnScreen: false,
      onSelect: handlers.openDeps ?? (() => undefined),
    },
    // Phase 3S — Ctrl+Y cycles autonomy tier. `scope: 'global'` matches
    // app.exit / focus.cycle / palette.open so the chord fires from
    // inside popups too (user may want to dial autonomy while reading
    // help or composing a Mission Control inject). Not flagged
    // `unbindable` — users CAN rebind via the 3H.4 editor; PLAN.md's
    // unbindable list is only for escape-hatch chords (Ctrl+C, Tab,
    // Shift+Tab) where rebinding would brick navigation.
    {
      id: 'app.cycleAutonomyTier',
      title: 'cycle autonomy tier',
      key: { kind: 'ctrl', char: 'y' },
      scope: 'global',
      displayOnScreen: false,
      onSelect: () =>
        handlers.cycleAutonomyTier?.() ??
        handlers.showLeaderToast?.('Autonomy tier cycle — handler not wired.'),
    },
    // Phase 3T — interrupt pivot. Two parallel commands so Esc AND
    // Ctrl+C both fire the same handler.
    //
    // Scope is `'main'` (chat/workers/output, silent in popups) so the
    // 3F.1 specificity rule lets Ctrl+C-as-pivot win over `app.exit`'s
    // global Ctrl+C kill-switch WHEN the disabledReason is unset (a
    // pivot is eligible). When all of "turn in flight / workers running
    // / pending queue" are false, this command is disabled, and the
    // dispatcher falls through to `app.exit` (dispatcher.tsx:247).
    //
    // Two-tap exit: the handler implementation (AppShell) tracks a
    // useRef<number> with `lastInterruptAt`. A second Ctrl+C within
    // 2s calls `handlers.requestExit()` instead of pivoting. Esc never
    // escalates (it's never a kill switch anywhere else).
    ...(state?.pivotEligible === false
      ? [] // disabled — fall through to app.exit on Ctrl+C, no-op on Esc
      : [
          {
            id: 'app.interrupt.esc',
            title: 'interrupt (pivot)',
            key: { kind: 'escape' as const },
            scope: 'main' as const,
            displayOnScreen: false,
            onSelect: () =>
              handlers.pivotInterruptEsc?.() ??
              handlers.showLeaderToast?.('Interrupt — handler not wired.'),
          },
          {
            id: 'app.interrupt.ctrlc',
            title: 'interrupt (pivot)',
            key: { kind: 'ctrl' as const, char: 'c' },
            scope: 'main' as const,
            displayOnScreen: false,
            onSelect: () =>
              handlers.pivotInterruptCtrlC?.() ??
              handlers.showLeaderToast?.('Interrupt — handler not wired.'),
          },
        ]),
  ];
}
