import React, { useEffect, useRef, useState, type RefObject } from 'react';
import { Box, Text, useBoxMetrics, useInput, type DOMElement } from 'ink';
import { useTheme } from '../../theme/context.js';
import { Bubble } from './Bubble.js';
import type { Turn } from '../../data/chatHistoryReducer.js';

/**
 * Vertical list of conversation turns with manual scrolling.
 *
 * 3B.2 model:
 *   - `useBoxMetrics(ref)` reports the panel's inner height each layout
 *     pass. We don't measure each bubble — instead, slice by *turn count*
 *     using the available height as a coarse budget. Long-tail histories
 *     where bubbles vary wildly in size are acceptable visual noise; the
 *     UX win is that overflow no longer truncates from the top.
 *   - `scrollOffset` is the number of turns hidden from the BOTTOM of the
 *     visible window. `0` = pinned to the latest turn (default).
 *   - `userScrolledUp` flips true whenever the user PageUp's. Resets when
 *     they jump to End. While true, new arriving turns do NOT auto-stick;
 *     scroll position holds.
 *   - PageUp/PageDown step by `Math.max(1, Math.floor(viewportTurns / 2))`
 *     turns. End resets to bottom + clears userScrolledUp.
 *
 * Re-renders on every reducer change — that's expected. The cost is
 * bounded because `<Bubble>` is `React.memo` with an identity comparator
 * (Plan-agent A2): only the LAST turn's bubble does work during streaming,
 * prior turns bail out.
 *
 * Empty-state hint intentionally NOT rendered here — `InputBar`'s
 * "Tell Maestro what to do…" placeholder serves the same purpose
 * without leaking when the user is mid-type.
 *
 * Naive turn-based slicing limitation: a single multi-line assistant
 * turn that overflows the viewport still truncates internally. Phase 3F
 * may upgrade to per-bubble line measurement; not blocking 3B.2.
 */

export interface MessageListProps {
  readonly turns: readonly Turn[];
  /** True when the chat panel currently owns focus. Gates scroll keys. */
  readonly isFocused: boolean;
}

const MIN_VIEWPORT_TURNS = 1;
/** Heuristic: average bubble height in rows when computing viewport budget. */
const ROWS_PER_TURN = 3;

export function MessageList({ turns, isFocused }: MessageListProps): React.JSX.Element {
  const theme = useTheme();
  // Ink's `useBoxMetrics` types its argument as `RefObject<DOMElement>`
  // (no null branch). React 19's `useRef<T>(null)` widens to
  // `RefObject<T | null>`, so we cast at the call site rather than
  // sprinkle non-null assertions through the consumer code.
  const ref = useRef<DOMElement | null>(null);
  const { height, hasMeasured } = useBoxMetrics(
    ref as RefObject<DOMElement>,
  );

  const [scrollOffset, setScrollOffset] = useState(0);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // Auto-stick on new turn arrival (only when user hasn't scrolled away).
  const prevTurnCount = useRef(turns.length);
  useEffect(() => {
    if (turns.length > prevTurnCount.current && !userScrolledUp) {
      setScrollOffset(0);
    }
    prevTurnCount.current = turns.length;
  }, [turns.length, userScrolledUp]);

  // viewportTurns: rough budget — assume an average bubble is ~3 rows
  // (header line + 1-2 content lines for short replies). When the
  // metrics aren't ready yet, fall back to all turns so the first
  // frame doesn't render empty.
  const viewportTurns = hasMeasured && height > 0
    ? Math.max(MIN_VIEWPORT_TURNS, Math.floor(height / ROWS_PER_TURN))
    : turns.length;

  const pageStep = Math.max(1, Math.floor(viewportTurns / 2));

  useInput(
    (_, key) => {
      if (key.pageUp) {
        setUserScrolledUp(true);
        setScrollOffset((prev) => {
          const max = Math.max(0, turns.length - viewportTurns);
          return Math.min(max, prev + pageStep);
        });
        return;
      }
      if (key.pageDown) {
        setScrollOffset((prev) => {
          const next = Math.max(0, prev - pageStep);
          if (next === 0) setUserScrolledUp(false);
          return next;
        });
        return;
      }
      // End — jump to bottom and resume auto-stick.
      if (key.end) {
        setScrollOffset(0);
        setUserScrolledUp(false);
        return;
      }
    },
    { isActive: isFocused },
  );

  // Slice the visible window. End-exclusive index from the array end is
  // `turns.length - scrollOffset`; start is `end - viewportTurns`.
  const end = Math.max(0, turns.length - scrollOffset);
  const start = Math.max(0, end - viewportTurns);
  const visible = turns.slice(start, end);

  const hiddenAbove = start;
  const hiddenBelow = scrollOffset;
  const hasOverflow = hiddenAbove > 0 || hiddenBelow > 0;

  return (
    <Box ref={ref} flexGrow={1} flexDirection="column">
      {hasOverflow ? (
        <Text color={theme['textMuted']} dimColor>
          {scrollHintText(hiddenAbove, hiddenBelow)}
        </Text>
      ) : null}
      {visible.map((turn) => (
        <Bubble key={turn.id} turn={turn} />
      ))}
    </Box>
  );
}

function scrollHintText(hiddenAbove: number, hiddenBelow: number): string {
  const parts: string[] = [];
  if (hiddenAbove > 0) parts.push(`↑ ${hiddenAbove} above`);
  if (hiddenBelow > 0) parts.push(`↓ ${hiddenBelow} below — End to jump`);
  return parts.join('  ·  ');
}
