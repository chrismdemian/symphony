import React, { useCallback, useEffect, useMemo } from 'react';
import { Box } from 'ink';
import { ThemeProvider, useThemeController } from './theme/context.js';
import { pickThemeJson } from './theme/theme.js';
import { FocusProvider, useFocus } from './focus/focus.js';
import { KeybindProvider } from './keybinds/dispatcher.js';
import { buildGlobalCommands } from './keybinds/global.js';
import { applyKeybindOverrides } from './keybinds/overrides.js';
import { Layout } from './layout/Layout.js';
import { useProjects } from './data/useProjects.js';
import { useWorkers } from './data/useWorkers.js';
import { useQueue } from './data/useQueue.js';
import { useSessionTotals } from './data/useSessionTotals.js';
import { useMode } from './data/useMode.js';
import { useQuestions } from './data/useQuestions.js';
import { WorkerSelectionProvider } from './data/WorkerSelection.js';
import {
  MaestroEventsProvider,
  useMaestroData,
  type MaestroController,
} from './data/MaestroEventsProvider.js';
import { useCompletionEvents } from './data/useCompletionEvents.js';
import { useInstrumentNames } from './data/useInstrumentNames.js';
import { InstrumentNameProvider } from './data/InstrumentNameContext.js';
import { AppActionsProvider } from './runtime/AppActions.js';
import { ToastProvider, useToast } from './feedback/ToastProvider.js';
import { ConfigProvider, useConfig } from '../utils/config-context.js';
import type { TuiRpc } from './runtime/rpc.js';

/**
 * Root component. Composes Theme/Focus/Keybind providers around the
 * Layout. Inner consumer (`AppShell`) reads data hooks and forwards to
 * `<Layout>`. Provider order matters:
 *   ThemeProvider — leaf-leveld, no deps
 *   FocusProvider — needed by KeybindProvider for scope lookup
 *   KeybindProvider — installs the global useInput listener
 *
 * `runTui` injects {maestro, rpc, version, onRequestExit}.
 */

export interface AppProps {
  readonly maestro: MaestroController;
  readonly rpc: TuiRpc;
  readonly version: string;
  /** Called when user triggers exit (Ctrl+C). Launcher owns the actual teardown. */
  readonly onRequestExit: () => void;
  /**
   * Phase 3H.1 — open a popup once on App mount (e.g. `'settings'`
   * when invoked via `symphony config`). Fired via mount-effect in
   * `<AppShell>` AFTER the focus provider has settled.
   */
  readonly initialPopup?: string;
}

export function App(props: AppProps): React.JSX.Element {
  return (
    <ThemeProvider>
      <ToastProvider>
        {/*
         * 3H.1: ConfigProvider mounts INSIDE ToastProvider so it can
         * surface load warnings via toast on mount, but OUTSIDE
         * FocusProvider/MaestroEventsProvider/etc. so the popup-scoped
         * SettingsPanel and the App-level keybind handler can both read
         * config from a single source. Initial load is async; defaults
         * fill until the file resolves (~5ms in practice).
         */}
        <ToastBoundConfigProvider>
          <FocusProvider>
            <WorkerSelectionProvider>
              <MaestroEventsProvider source={props.maestro}>
                <AppShell {...props} />
              </MaestroEventsProvider>
            </WorkerSelectionProvider>
          </FocusProvider>
        </ToastBoundConfigProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

/**
 * Internal helper — wires `<ConfigProvider>`'s warning sink to the
 * toast tray. Lives inline rather than as an external file because it
 * only exists to bridge the two providers' callback shapes.
 */
function ToastBoundConfigProvider(props: { readonly children: React.ReactNode }): React.JSX.Element {
  const { showToast } = useToast();
  return (
    <ConfigProvider onWarning={(message) => showToast(message, { tone: 'warning', ttlMs: 6_000 })}>
      {props.children}
    </ConfigProvider>
  );
}

function AppShell(props: AppProps): React.JSX.Element {
  const focus = useFocus();
  const { showToast } = useToast();
  const { config } = useConfig();
  const { projects } = useProjects(props.rpc);
  const workersResult = useWorkers(props.rpc);
  const queueResult = useQueue(props.rpc);
  const sessionTotalsResult = useSessionTotals(props.rpc);
  const { mode } = useMode(props.rpc);
  const questionsResult = useQuestions(props.rpc);
  const { sessionId, pushSystem } = useMaestroData();

  // Phase 3K — subscribe to the orchestrator's `completions.events`
  // topic and forward each summary into the chat panel as a system
  // turn. Instrument name resolution happens at render time (in the
  // Bubble, via InstrumentNameContext) rather than at receipt — workers
  // that complete inside a single 1-s poll window aren't yet in the
  // allocator's input set; a render-time lookup recovers the proper
  // name once the next poll surfaces them. Audit C1.
  const instruments = useInstrumentNames(workersResult.workers);
  const resolveInstrumentName = useCallback(
    (workerId: string) => instruments.get(workerId),
    [instruments],
  );
  useCompletionEvents({
    rpc: props.rpc,
    pushSystem,
  });

  // Phase 3H.2 — own the probe-driven theme swap from inside the
  // config-aware tree. ThemeProvider initializes truecolor; this effect
  // runs on mount AND on every `config.theme.autoFallback16Color`
  // change to swap to 16-color when the probe says so. `setThemeJson`
  // is identity-stable across the provider's lifetime so the dep
  // array doesn't churn with every render (audit M1).
  const { setThemeJson } = useThemeController();
  const autoFallback = config.theme.autoFallback16Color;
  useEffect(() => {
    setThemeJson(pickThemeJson(autoFallback));
  }, [autoFallback, setThemeJson]);

  // Phase 3H.3 + Phase 3M — awayMode edge handling.
  //
  // On EVERY change (both directions), push the new value to the
  // server's dispatch context via `runtime.setAwayMode` so the
  // capability shim (`capabilities.ts`) sees it on the next tool call.
  // The 3H.3 dispatcher reads config fresh per event, so its buffering
  // policy was already reactive; this seam closes the gap for the
  // host-browser-control rejection path.
  //
  // On the true→false edge specifically, ALSO flush the digest and
  // render the result as a chat system row. The PLAN.md §3M return-from-
  // away spec calls for "While you were away: N completed, N failed, N
  // questions" — flushAwayDigest now returns the formatted body so the
  // TUI can render the row without re-deriving the tally client-side.
  //
  // Race-window note (audit M2, commit 1): the in-TUI toggle path
  // (`toggleAwayMode` below) calls `runtime.setAwayMode` BEFORE writing
  // disk, closing the window during which the dispatcher (disk-fresh)
  // and capability shim (memory-stale) could disagree. External edit
  // paths (`symphony config --edit`, SettingsPanel Space-toggle) still
  // hit this effect for the RPC sync after the disk write lands, so the
  // worst case is a microsecond-scale stale window — acceptable for the
  // MVP. Remote-client work (Phase 5/8) needs additional ordering care.
  //
  // `prevAwayModeRef` is initialized to the current value so the first
  // effect run (on mount) is a no-op even if awayMode is somehow true
  // at boot. Mirrors the firedRef pattern from 3H.1's ConfigProvider
  // warnings useEffect.
  const awayMode = config.awayMode;
  const prevAwayModeRef = React.useRef(awayMode);
  const rpc = props.rpc;
  useEffect(() => {
    const prev = prevAwayModeRef.current;
    if (prev === awayMode) return;
    prevAwayModeRef.current = awayMode;
    // Always sync the server's dispatch context. Idempotent
    // server-side; no-op when `toggleAwayMode` already pushed the value
    // for the same flip.
    void rpc.call.runtime.setAwayMode({ awayMode }).catch(() => {
      // Best-effort; capability-shim consequence is documented in the
      // race-window note above.
    });
    if (prev === true && awayMode === false) {
      void rpc.call.notifications
        .flushAwayDigest()
        .then((result) => {
          if (result.digest !== null) {
            // Synthesize a "while you were away" system row. Uses the
            // existing SystemSummary shape; workerName='Symphony' since
            // this is the orchestrator's own announcement, projectName
            // is intentionally empty (Away Mode is global, not
            // project-scoped), and durationMs is null. SystemBubble
            // skips the parens/duration tail when both are empty
            // (Phase 3M Bubble change).
            pushSystem({
              workerId: `away-digest-${Date.now()}`,
              workerName: 'Symphony',
              projectName: '',
              // 'completed' renders with the gold ✓ glyph
              // (statusGlyph map in Bubble.tsx). Away digests aren't a
              // worker completion per se — but visually 'completed'
              // is the right success-toned token.
              statusKind: 'completed',
              durationMs: null,
              headline: `While you were away: ${result.digest}`,
              fallback: false,
            });
          }
        })
        .catch(() => {
          // Flush failure is best-effort; dispatcher errors are
          // swallowed server-side, and the user can re-toggle away mode
          // to retry.
        });
    }
  }, [awayMode, rpc, pushSystem]);

  // Phase 3H.1 — `--initial-popup`/`symphony config` entry point.
  // Fires exactly once after mount. The ref-guard handles the StrictMode
  // double-invoke in development without re-pushing the popup.
  const initialPopupFiredRef = React.useRef(false);
  const initialPopupKey = props.initialPopup;
  React.useEffect(() => {
    if (initialPopupFiredRef.current) return;
    if (initialPopupKey === undefined) return;
    initialPopupFiredRef.current = true;
    focus.pushPopup(initialPopupKey);
  }, [initialPopupKey, focus.pushPopup]);

  // Phase 3H.2 — real `<leader>m` and `<leader>t` handlers. Each
  // calls `setConfig` with a function-patch (audit C2 fix), surfaces a
  // toast, and either rejects via try/catch (Zod validation should
  // never trigger here, but we toast any unexpected failure rather
  // than silently dropping).
  //
  // Audit M1 (3H.2 commit 5): both toasts honestly advertise the
  // "applies on next start" semantics. `globalModelMode` is captured
  // at orchestrator boot via `loadConfig` (`server.ts`); the disk
  // write is immediate, but the orchestrator's `getDefaultModel`
  // closure stays bound to the boot-time value until restart. Theme
  // fallback DOES apply mid-session via the AppShell effect — the
  // toast reflects that. Don't promise immediate effect for modelMode.
  const { setConfig } = useConfig();
  const cycleModelMode = useCallback(async () => {
    try {
      // Function-patch resolves against the freshly-committed state
      // INSIDE the setConfig serialization queue (audit C2). Two
      // rapid-fire `<leader>m m` chord presses each see the
      // post-flip value rather than the same stale render capture.
      const next = await setConfig((current) => ({
        modelMode: current.modelMode === 'opus' ? 'mixed' : 'opus',
      }));
      showToast(`Model mode: ${next.modelMode} (applies on next start).`, {
        tone: 'info',
        ttlMs: 4_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Model mode change failed: ${msg}`, { tone: 'error' });
    }
  }, [setConfig, showToast]);

  const toggleThemeFallback = useCallback(async () => {
    try {
      const next = await setConfig((current) => ({
        theme: { autoFallback16Color: !current.theme.autoFallback16Color },
      }));
      showToast(`Theme fallback: ${next.theme.autoFallback16Color ? 'on' : 'off'}.`, {
        tone: 'info',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Theme fallback change failed: ${msg}`, { tone: 'error' });
    }
  }, [setConfig, showToast]);

  // Phase 3M — `/away` slash command + `<leader>a` chord both call
  // this. Resolves the next value via `setConfig`'s function-patch so
  // a rapid double-press can't close-capture the same `config.awayMode`
  // snapshot (audit M1/M2 from commit 2 — same pattern as
  // `cycleModelMode` above).
  //
  // The RPC sync to the server's dispatch context lives entirely in the
  // awayMode useEffect below; it observes the state change after commit
  // and pushes `runtime.setAwayMode` regardless of who triggered the
  // toggle (this handler, SettingsPanel Space, or external `symphony
  // config --edit`). Commit 1's audit M2 (microsecond in-process race
  // between disk-fresh dispatcher and memory-stale capability shim) is
  // accepted for the MVP — see the useEffect's race-window comment.
  // The digest flush + system row also fire from the useEffect's
  // true→false branch so all toggle paths converge.
  const toggleAwayMode = useCallback(async () => {
    try {
      const next = await setConfig((current) => ({ awayMode: !current.awayMode }));
      showToast(`Away mode: ${next.awayMode ? 'on' : 'off'}.`, {
        tone: 'info',
        ttlMs: 3_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Away mode toggle failed: ${msg}`, { tone: 'error' });
    }
  }, [setConfig, showToast]);

  const appActions = useMemo(
    () => ({
      onRequestExit: props.onRequestExit,
      toggleAwayMode,
    }),
    [props.onRequestExit, toggleAwayMode],
  );

  const commands = useMemo(
    () =>
      buildGlobalCommands(
        {
          cycleFocus: focus.cycle,
          cycleFocusReverse: focus.cycleReverse,
          requestExit: props.onRequestExit,
          showHelp: () => focus.pushPopup('help'),
          openPalette: () => focus.pushPopup('palette'),
          openWorkerSelect: () => focus.pushPopup('worker-select'),
          openQuestions: () => focus.pushPopup('question'),
          openQuestionHistory: () => focus.pushPopup('question-history'),
          showLeaderToast: (message) => showToast(message, { tone: 'info' }),
          cycleModelMode,
          toggleThemeFallback,
          // Phase 3H.1 — Ctrl+, opens settings; palette-only command
          // `app.configEdit` shows a toast for now (the actual $EDITOR
          // spawn lives in the CLI subcommand, not the in-TUI handler —
          // a running TUI inheriting stdio would conflict with the
          // editor's claim on the terminal). The toast tells the user
          // to run `symphony config --edit` from a separate shell.
          openSettings: () => focus.pushPopup('settings'),
          openSettingsEdit: () =>
            showToast(
              'Run `symphony config --edit` from a shell to edit ~/.symphony/config.json in $EDITOR.',
              { tone: 'info', ttlMs: 5_000 },
            ),
          // Phase 3H.4 — both palette commands route to the same
          // keybind-list popup. `openKeybindReset` is a discovery
          // surface; the actual reset action is `r` on a list row.
          openKeybindEditor: () => focus.pushPopup('keybind-list'),
          openKeybindReset: () => focus.pushPopup('keybind-list'),
          // Phase 3M — `<leader>a` chord + palette entry.
          toggleAwayMode,
        },
        {
          questionsCount: questionsResult.count,
          workersCount: workersResult.workers.length,
        },
      ),
    [
      focus.cycle,
      focus.cycleReverse,
      focus.pushPopup,
      props.onRequestExit,
      questionsResult.count,
      workersResult.workers.length,
      showToast,
      cycleModelMode,
      toggleThemeFallback,
      toggleAwayMode,
    ],
  );

  // Phase 3H.4 — apply user keybind overrides. `applyKeybindOverrides`
  // is identity-preserving when no overrides are present, so this
  // useMemo doesn't churn for users with a default config. Internal
  // popup-nav commands are excluded by the helper itself, so popup
  // Esc/Enter/arrows are never overridden even if a malformed override
  // entry targets one (defense-in-depth alongside salvage).
  const keybindOverrides = config.keybindOverrides;
  const overriddenCommands = useMemo(
    () => applyKeybindOverrides(commands, keybindOverrides),
    [commands, keybindOverrides],
  );

  return (
    <AppActionsProvider value={appActions}>
      <KeybindProvider initialCommands={overriddenCommands} leaderTimeoutMs={config.leaderTimeoutMs}>
        <InstrumentNameProvider value={resolveInstrumentName}>
          <Box flexDirection="column" width="100%" height="100%">
            <Layout
              version={props.version}
              mode={mode}
              projects={projects}
              workers={workersResult.workers}
              sessionId={sessionId}
              rpc={props.rpc}
              workersResult={workersResult}
              queueResult={queueResult}
              questionsResult={questionsResult}
              awayMode={awayMode}
              sessionTotals={sessionTotalsResult.totals}
            />
          </Box>
        </InstrumentNameProvider>
      </KeybindProvider>
    </AppActionsProvider>
  );
}
