import React from 'react';
import { Text } from 'ink';
import { Panel } from '../layout/Panel.js';
import { useTheme } from '../theme/context.js';

/**
 * Phase 3A placeholder. Phase 3B fills this with:
 * - scrollable message history
 * - distinguishing user vs Maestro messages
 * - Symphony spinner + orchestral status verbs
 * - shimmer effect during processing
 * - tool call summaries
 * - input bar with multi-line support
 */
export function ChatPanel(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Panel focusKey="chat" title="Chat" flexGrow={1}>
      <Text color={theme['textMuted']} dimColor>
        Chat panel — Phase 3B will land here.
      </Text>
      <Text color={theme['textMuted']} dimColor>
        Type to send a message to Maestro (input bar coming in 3B).
      </Text>
    </Panel>
  );
}
