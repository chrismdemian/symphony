import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Box, Text, useBoxMetrics, useInput, type DOMElement } from 'ink';
import { useTheme } from '../../theme/context.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import { Equalizer } from '../../anim/Equalizer.js';
import type { TuiRpc } from '../../runtime/rpc.js';
import { useWorkerEvents } from '../../data/useWorkerEvents.js';
import { EventRow } from './EventRow.js';
import { RateLimitBanner } from './RateLimitBanner.js';

/**
 * Phase 3D.1 — output panel body for one selected worker.
 *
 * Mounted via `<WorkerOutputView key={workerId}/>` so React unmounts +
 * remounts the entire subtree on selection change. That gives us a free
 * reducer-state reset and a free unsubscribe-from-old-worker effect
 * cleanup (the hook's `[rpc, workerId]` dep would handle it too, but
 * `key` is the simpler design — see PLAN.md decision).
 *
 * Scroll machinery mirrors 3B.2's `MessageList`: PageUp/PageDown step by
 * half-viewport, End jumps to bottom + clears `userScrolledUp`,
 * auto-stick when new events arrive (only while not scrolled up). `g`/`G`
 * jump-to-top/bottom and `j`/`k` line-by-line are panel-scoped commands
 * registered via `useRegisterCommands(commands, isFocused)` so they
 * don't fire while typing in the chat input.
 *
 * Empty states:
 *   - `!backfillReady && events.length === 0` → "Waiting for first
 *     event…" + Equalizer spinner. Backfill resolves quickly (a single
 *     RPC roundtrip), so this is mostly a transient flash.
 *   - `backfillReady && events.length === 0` → "(no output captured
 *     yet)" muted hint.
 *
 * `subscribeError` renders as a single red row above the event log.
 * Live events still flow if subscribe succeeded but the tail RPC failed.
 */

const MIN_VIEWPORT_EVENTS = 1;
/** Heuristic: average event height in rows. Tool results are taller (up
 * to 12 lines via formatToolResult); assistant text + one-liners are
 * 1-2. Choose a middle value for the budget. */
const ROWS_PER_EVENT = 2;

export interface WorkerOutputViewProps {
  readonly rpc: TuiRpc;
  readonly workerId: string;
  readonly isFocused: boolean;
}

export function WorkerOutputView({
  rpc,
  workerId,
  isFocused,
}: WorkerOutputViewProps): React.JSX.Element {
  const theme = useTheme();
  const state = useWorkerEvents(rpc, workerId);
  const ref = useRef<DOMElement | null>(null);
  const { height, hasMeasured } = useBoxMetrics(ref as RefObject<DOMElement>);

  const [scrollOffset, setScrollOffset] = useState(0);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  const eventCount = state.events.length;

  // Auto-stick when new events arrive (only while user hasn't scrolled
  // up). Mirrors `MessageList`'s pattern.
  const prevEventCount = useRef(eventCount);
  useEffect(() => {
    if (eventCount > prevEventCount.current && !userScrolledUp) {
      setScrollOffset(0);
    }
    prevEventCount.current = eventCount;
  }, [eventCount, userScrolledUp]);

  const viewportEvents =
    hasMeasured && height > 0
      ? Math.max(MIN_VIEWPORT_EVENTS, Math.floor(height / ROWS_PER_EVENT))
      : eventCount;

  const pageStep = Math.max(1, Math.floor(viewportEvents / 2));

  // Built-in scroll keys (PageUp/PageDown/End) handled inline via
  // useInput so they integrate with `isActive`. The keybind-registry
  // commands handle `g/G/j/k` so they show up in the bar.
  useInput(
    (_, key) => {
      if (key.pageUp) {
        setUserScrolledUp(true);
        setScrollOffset((prev) => {
          const max = Math.max(0, eventCount - viewportEvents);
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
      if (key.end) {
        setScrollOffset(0);
        setUserScrolledUp(false);
        return;
      }
    },
    { isActive: isFocused },
  );

  const jumpTop = useCallback(() => {
    setUserScrolledUp(true);
    const max = Math.max(0, eventCount - viewportEvents);
    setScrollOffset(max);
  }, [eventCount, viewportEvents]);

  const jumpBottom = useCallback(() => {
    setScrollOffset(0);
    setUserScrolledUp(false);
  }, []);

  const lineUp = useCallback(() => {
    setUserScrolledUp(true);
    setScrollOffset((prev) => {
      const max = Math.max(0, eventCount - viewportEvents);
      return Math.min(max, prev + 1);
    });
  }, [eventCount, viewportEvents]);

  const lineDown = useCallback(() => {
    setScrollOffset((prev) => {
      const next = Math.max(0, prev - 1);
      if (next === 0) setUserScrolledUp(false);
      return next;
    });
  }, []);

  const commands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'output.jumpTop',
        title: 'top',
        key: { kind: 'char', char: 'g' },
        scope: 'output',
        displayOnScreen: true,
        onSelect: jumpTop,
      },
      {
        id: 'output.jumpBottom',
        title: 'bottom',
        key: { kind: 'char', char: 'G' },
        scope: 'output',
        displayOnScreen: true,
        onSelect: jumpBottom,
      },
      {
        id: 'output.lineDown',
        title: 'down',
        key: { kind: 'char', char: 'j' },
        scope: 'output',
        displayOnScreen: false,
        onSelect: lineDown,
      },
      {
        id: 'output.lineUp',
        title: 'up',
        key: { kind: 'char', char: 'k' },
        scope: 'output',
        displayOnScreen: false,
        onSelect: lineUp,
      },
    ],
    [jumpTop, jumpBottom, lineUp, lineDown],
  );

  useRegisterCommands(commands, isFocused);

  // Slice the visible window. End-exclusive index from the array end is
  // `eventCount - scrollOffset`; start is `end - viewportEvents`.
  const end = Math.max(0, eventCount - scrollOffset);
  const start = Math.max(0, end - viewportEvents);
  const visible = state.events.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = scrollOffset;
  const hasOverflow = hiddenAbove > 0 || hiddenBelow > 0;

  const isEmpty = eventCount === 0;
  const isWaiting = isEmpty && !state.backfillReady;

  return (
    <Box ref={ref} flexGrow={1} flexDirection="column">
      <RateLimitBanner retry={state.lastRetryEvent} />
      {state.subscribeError !== null ? (
        <Text color={theme['error']}>output stream error: {state.subscribeError.message}</Text>
      ) : null}
      {hasOverflow ? (
        <Text color={theme['textMuted']} dimColor>
          {scrollHintText(hiddenAbove, hiddenBelow)}
        </Text>
      ) : null}
      {isWaiting ? (
        <Box>
          <Equalizer />
          <Text color={theme['textMuted']}>
            {'  '}Waiting for first event…
          </Text>
        </Box>
      ) : isEmpty ? (
        <Text color={theme['textMuted']}>
          (no output captured yet)
        </Text>
      ) : (
        visible.map((event, idx) => (
          <EventRow key={`${start + idx}::${event.type}`} event={event} />
        ))
      )}
    </Box>
  );
}

function scrollHintText(hiddenAbove: number, hiddenBelow: number): string {
  const parts: string[] = [];
  if (hiddenAbove > 0) parts.push(`↑ ${hiddenAbove} above`);
  if (hiddenBelow > 0) parts.push(`↓ ${hiddenBelow} below — End to jump`);
  return parts.join('  ·  ');
}
