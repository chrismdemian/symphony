import React from 'react';
import { Box } from 'ink';
import { Bubble } from './Bubble.js';
import type { Turn } from '../../data/chatHistoryReducer.js';

/**
 * Vertical list of conversation turns.
 *
 * 3B.1 ships a non-scrolling list — long histories overflow the panel
 * inner box and are truncated at the top by Ink's default flex layout.
 * Phase 3B.2 adds `useBoxMetrics`-backed scrolling, PageUp/Down keys,
 * and the auto-stick-to-bottom behavior (lazygit pattern).
 *
 * Re-renders on every reducer change — that's expected. The cost is
 * bounded because `<Bubble>` is `React.memo` with an identity
 * comparator (Plan-agent A2): only the LAST turn's bubble does work
 * during streaming, prior turns bail out.
 *
 * Empty-state hint intentionally NOT rendered here — `InputBar`'s
 * "Tell Maestro what to do…" placeholder serves the same purpose
 * without leaking when the user is mid-type (Phase 3B.1 visual review).
 */

export interface MessageListProps {
  readonly turns: readonly Turn[];
}

export function MessageList({ turns }: MessageListProps): React.JSX.Element {
  return (
    <Box flexGrow={1} flexDirection="column">
      {turns.map((turn) => (
        <Bubble key={turn.id} turn={turn} />
      ))}
    </Box>
  );
}
