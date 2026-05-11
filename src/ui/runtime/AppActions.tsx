import React, { createContext, useContext, type ReactNode } from 'react';

/**
 * App-wide imperative actions panels can call without prop-drilling.
 *
 * `onRequestExit` is wired by `runTui.ts` to the launcher's `stop()`,
 * preserving the audit-validated 5s + Win32 `taskkill /T /F` shutdown
 * chain (Phase 2C.2). 3B.2's `/quit` slash command is the first
 * non-keybind caller; Phase 3F's help overlay + command palette will
 * pull from this same context for cancel / exit affordances.
 *
 * Keep this context narrow — it's for actions that the keybind registry
 * already handles. Don't grow it into a kitchen-sink dependency
 * injection mechanism.
 */

export interface AppActions {
  readonly onRequestExit: () => void;
  /**
   * Phase 3M — `/away` slash command + `<leader>a` chord both call this.
   * Optional during 3M transition (pre-3M tests construct AppActions
   * without it); ChatPanel only registers the slash entry when defined.
   */
  readonly toggleAwayMode?: () => void | Promise<void>;
}

const AppActionsContext = createContext<AppActions | null>(null);

export interface AppActionsProviderProps {
  readonly value: AppActions;
  readonly children: ReactNode;
}

export function AppActionsProvider({
  value,
  children,
}: AppActionsProviderProps): React.JSX.Element {
  return (
    <AppActionsContext.Provider value={value}>{children}</AppActionsContext.Provider>
  );
}

export function useAppActions(): AppActions {
  const ctx = useContext(AppActionsContext);
  if (ctx === null) {
    throw new Error('useAppActions() called outside <AppActionsProvider>');
  }
  return ctx;
}
