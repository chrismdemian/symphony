import React, { useMemo } from 'react';
import { Box } from 'ink';
import { ThemeProvider } from './theme/context.js';
import { FocusProvider, useFocus } from './focus/focus.js';
import { KeybindProvider } from './keybinds/dispatcher.js';
import { buildGlobalCommands } from './keybinds/global.js';
import { Layout } from './layout/Layout.js';
import { useProjects } from './data/useProjects.js';
import { useWorkers } from './data/useWorkers.js';
import { useMode } from './data/useMode.js';
import {
  MaestroEventsProvider,
  useMaestroData,
  type MaestroController,
} from './data/MaestroEventsProvider.js';
import { AppActionsProvider } from './runtime/AppActions.js';
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
}

export function App(props: AppProps): React.JSX.Element {
  const actions = useMemo(
    () => ({ onRequestExit: props.onRequestExit }),
    [props.onRequestExit],
  );
  return (
    <ThemeProvider>
      <FocusProvider>
        <AppActionsProvider value={actions}>
          <MaestroEventsProvider source={props.maestro}>
            <AppShell {...props} />
          </MaestroEventsProvider>
        </AppActionsProvider>
      </FocusProvider>
    </ThemeProvider>
  );
}

function AppShell(props: AppProps): React.JSX.Element {
  const focus = useFocus();
  const { projects } = useProjects(props.rpc);
  const { workers } = useWorkers(props.rpc);
  const { mode } = useMode(props.rpc);
  const { sessionId } = useMaestroData();

  const commands = useMemo(
    () =>
      buildGlobalCommands({
        cycleFocus: focus.cycle,
        cycleFocusReverse: focus.cycleReverse,
        requestExit: props.onRequestExit,
        showHelp: () => {
          // 3A stub — Phase 3F installs the help overlay.
        },
      }),
    [focus.cycle, focus.cycleReverse, props.onRequestExit],
  );

  return (
    <KeybindProvider initialCommands={commands}>
      <Box flexDirection="column" width="100%" height="100%">
        <Layout
          version={props.version}
          mode={mode}
          projects={projects}
          workers={workers}
          sessionId={sessionId}
        />
      </Box>
    </KeybindProvider>
  );
}
