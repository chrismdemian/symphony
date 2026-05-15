import React, { useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../../layout/Panel.js';
import { useFocus } from '../../focus/focus.js';
import { useTheme } from '../../theme/context.js';
import { useMaestroData } from '../../data/MaestroEventsProvider.js';
import { useAppActions } from '../../runtime/AppActions.js';
import { MessageList } from './MessageList.js';
import { InputBar } from './InputBar.js';
import { StatusLine } from './StatusLine.js';
import { buildSlashTable, dispatchSlash } from './slashCommands.js';

/**
 * Phase 3B.2 chat panel.
 *
 * Layers:
 *   ┌──────────────────────┐
 *   │  MessageList (grow)  │   scrolls — PageUp/PageDown/End
 *   ├──────────────────────┤
 *   │  InputBar (shrink)   │   usePaste channel; Ctrl+J newline
 *   └──────────────────────┘
 *
 * 3B.2 wires: slash command dispatch (`/quit` → onRequestExit), tool
 * call summaries inline in bubbles, paste channel, scrolling, and the
 * content-derived block keys (audit M6). 3B.3 adds the Equalizer +
 * ShimmerText status line and true Shift+Enter via kitty mode.
 */

export function ChatPanel(): React.JSX.Element {
  const focus = useFocus();
  const theme = useTheme();
  const data = useMaestroData();
  const actions = useAppActions();
  const [error, setError] = useState<string | undefined>();

  // Phase 3E: derive from `currentScope`, not `currentMainKey`. Today,
  // `<Layout>` unmounts the chat panel while a popup is on top so the
  // dual-mount-of-InputBar concern doesn't fire in production — but
  // any future overlay-style popup (Layout retains the panels behind a
  // dimmed overlay) would otherwise let the popup's InputBar AND the
  // chat InputBar BOTH consume keystrokes in parallel. Audit M4 from
  // 3e: the right invariant is `currentScope`; the unmount workaround
  // is a current-Layout artifact, not a contract.
  const isFocused = focus.currentScope === 'chat';

  // Audit M3: defer onRequestExit out of the synchronous useInput
  // dispatch so the React commit completes before the launcher tears
  // down the Ink tree. Without setImmediate we're synchronously
  // unmounting from inside our own input dispatch — undocumented
  // behavior in Ink, and double-tap-Enter could re-fire before the
  // first unmount lands.
  const slashTable = useMemo(
    () =>
      buildSlashTable({
        quit: () => setImmediate(() => actions.onRequestExit()),
        // Phase 3H.1 — `/config` opens the settings popup. Mirrors
        // Ctrl+, in the global keybind table.
        openSettings: () => focus.pushPopup('settings'),
        // Phase 3M — `/away` toggles config.awayMode. Same handler as
        // `<leader>a` (registered in App.tsx via GlobalCommandHandlers).
        // Only registered when the action is wired so tests building
        // AppActions without it keep behavioral parity with pre-3M.
        ...(actions.toggleAwayMode !== undefined
          ? { toggleAway: () => void actions.toggleAwayMode?.() }
          : {}),
        // Phase 3N.3 — `/stats` opens the session-stats popup. Mirrors
        // `app.stats` palette entry.
        openStats: () => focus.pushPopup('stats'),
        // Phase 3P — `/deps` opens the dep-graph popup.
        openDeps: () => focus.pushPopup('deps'),
        // Phase 3R — `/log` opens the audit-log popup.
        openLog: () => focus.pushPopup('log'),
      }),
    [actions.onRequestExit, actions.toggleAwayMode, focus.pushPopup],
  );

  const handleSubmit = (text: string): void => {
    const outcome = dispatchSlash(text, slashTable);
    if (outcome === 'dispatched') {
      setError(undefined);
      return;
    }
    if (outcome === 'unknown') {
      // Surface inline so users learn the command isn't real, rather
      // than silently sending `/foo` to Maestro.
      setError(`Unknown command: ${text.trim().split(/\s+/)[0] ?? ''}`);
      return;
    }
    const result = data.sendUserMessage(text);
    if (result.ok) {
      setError(undefined);
      return;
    }
    if (result.reason === 'turn_in_flight') {
      setError('A previous turn is still streaming — wait for it to finish.');
      return;
    }
    setError(`Send failed: ${result.message}`);
  };

  return (
    <Panel focusKey="chat" title="Chat" flexGrow={1}>
      <Box flexDirection="column" flexGrow={1}>
        <MessageList turns={data.turns} isFocused={isFocused} />
        <StatusLine turn={data.turn} turns={data.turns} />
        <InputBar onSubmit={handleSubmit} isActive={isFocused} />
        {error !== undefined ? (
          // Visual review: error MUST live outside the InputBar's
          // border — inside reads as user-typed content.
          <Text color={theme['error']}>{error}</Text>
        ) : null}
      </Box>
    </Panel>
  );
}
