import React, { useCallback, useEffect, useMemo } from 'react';
import { Box } from 'ink';
import { ThemeProvider, useThemeController } from './theme/context.js';
import { pickThemeJson } from './theme/theme.js';
import { FocusProvider, useFocus } from './focus/focus.js';
import { KeybindProvider } from './keybinds/dispatcher.js';
import { buildGlobalCommands } from './keybinds/global.js';
import { Layout } from './layout/Layout.js';
import { useProjects } from './data/useProjects.js';
import { useWorkers } from './data/useWorkers.js';
import { useMode } from './data/useMode.js';
import { useQuestions } from './data/useQuestions.js';
import { WorkerSelectionProvider } from './data/WorkerSelection.js';
import {
  MaestroEventsProvider,
  useMaestroData,
  type MaestroController,
} from './data/MaestroEventsProvider.js';
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
  const actions = useMemo(
    () => ({ onRequestExit: props.onRequestExit }),
    [props.onRequestExit],
  );
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
            <AppActionsProvider value={actions}>
              <WorkerSelectionProvider>
                <MaestroEventsProvider source={props.maestro}>
                  <AppShell {...props} />
                </MaestroEventsProvider>
              </WorkerSelectionProvider>
            </AppActionsProvider>
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
  const { mode } = useMode(props.rpc);
  const questionsResult = useQuestions(props.rpc);
  const { sessionId } = useMaestroData();

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

  // Phase 3H.3 — awayMode flush detection. The dispatcher (server-side)
  // accumulates notifications while `config.awayMode === true`. When the
  // user toggles it back to false (currently via SettingsPanel; future
  // 3M will add a dedicated keybind), this effect's edge detector calls
  // the RPC `flushAwayDigest` so the orchestrator emits one batched
  // toast covering the buffered events.
  //
  // `prevAwayModeRef` is initialized to the current value so the first
  // effect run (on mount) is a no-op even if awayMode is somehow true
  // at boot. Only an actual `true → false` transition triggers a flush.
  // Mirrors the firedRef pattern from 3H.1's ConfigProvider warnings
  // useEffect.
  const awayMode = config.awayMode;
  const prevAwayModeRef = React.useRef(awayMode);
  const rpc = props.rpc;
  useEffect(() => {
    const prev = prevAwayModeRef.current;
    prevAwayModeRef.current = awayMode;
    if (prev === true && awayMode === false) {
      void rpc.call.notifications.flushAwayDigest().catch(() => {
        // Notification flush is best-effort; an RPC failure here is not
        // user-actionable and dispatcher errors are already swallowed
        // server-side.
      });
    }
  }, [awayMode, rpc]);

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
    ],
  );

  return (
    <KeybindProvider initialCommands={commands} leaderTimeoutMs={config.leaderTimeoutMs}>
      <Box flexDirection="column" width="100%" height="100%">
        <Layout
          version={props.version}
          mode={mode}
          projects={projects}
          workers={workersResult.workers}
          sessionId={sessionId}
          rpc={props.rpc}
          workersResult={workersResult}
          questionsResult={questionsResult}
        />
      </Box>
    </KeybindProvider>
  );
}
