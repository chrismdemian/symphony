import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { Panel } from '../../layout/Panel.js';
import { useFocus } from '../../focus/focus.js';
import { useTheme } from '../../theme/context.js';
import { useMaestroData } from '../../data/MaestroEventsProvider.js';
import { MessageList } from './MessageList.js';
import { InputBar } from './InputBar.js';

/**
 * Phase 3B.1 chat panel.
 *
 * Layers:
 *   ┌──────────────────────┐
 *   │  MessageList (grow)  │
 *   ├──────────────────────┤
 *   │  InputBar (shrink)   │
 *   └──────────────────────┘
 *
 * 3B.1 keeps it minimal — no scrolling, no slash commands, no
 * status-line spinner. 3B.2 adds usePaste / `/quit` / scroll;
 * 3B.3 adds the Equalizer + ShimmerText status line and true
 * Shift+Enter via the kitty keyboard protocol.
 */

export function ChatPanel(): React.JSX.Element {
  const focus = useFocus();
  const theme = useTheme();
  const data = useMaestroData();
  const [error, setError] = useState<string | undefined>();

  const isFocused = focus.currentMainKey === 'chat';

  const handleSubmit = (text: string): void => {
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
        <MessageList turns={data.turns} />
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
