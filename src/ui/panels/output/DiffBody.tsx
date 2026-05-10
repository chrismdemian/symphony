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
import { applyKeybindOverrides } from '../../keybinds/overrides.js';
import { useConfig } from '../../../utils/config-context.js';
import { colorizeDiff, type DiffLineKind } from './diffColorize.js';

/**
 * Phase 3J — scrollable diff body for the output panel's diff view.
 *
 * Line-based scroll (vs `WorkerOutputView`'s event-based) — diffs are
 * naturally line-oriented. Same key contract as the streaming view so
 * users don't have to re-learn the keys when toggling:
 *   - PageUp / PageDown: half-viewport
 *   - End: jump to bottom + resume auto-stick (no auto-stick semantics
 *     here since the diff isn't streaming, but End === bottom is the
 *     convention)
 *   - g / G: top / bottom
 *   - j / k: line-by-line
 *
 * Scope: registered against `'output'` panel scope so the keys silently
 * disable when chat or workers panel has focus. No conflict with
 * `WorkerOutputView`'s commands — those are unmounted when the diff
 * view is mounted (the container swaps which view is rendered).
 *
 * `colorizeDiff` runs once per `source` change (memoized), then we slice
 * the line array against the viewport. Theme tokens reuse 3F.4's diff
 * palette: `diffAdd` / `diffRemove` / `diffHunk` / `diffMeta` /
 * `diffContext`. No new theme work.
 */

export interface DiffBodyProps {
  readonly source: string;
  readonly isFocused: boolean;
}

const MIN_VIEWPORT_LINES = 1;

export function DiffBody({ source, isFocused }: DiffBodyProps): React.JSX.Element {
  const theme = useTheme();
  const ref = useRef<DOMElement | null>(null);
  const { height, hasMeasured } = useBoxMetrics(ref as RefObject<DOMElement>);

  const lines = useMemo(() => colorizeDiff(source), [source]);
  const lineCount = lines.length;

  const [scrollOffset, setScrollOffset] = useState(0);

  // When source changes (e.g., refresh produced new diff), reset scroll
  // to the top — fresh content, fresh view. Mirrors the way EventRow
  // reducer state resets via key remount on workerId change.
  const prevSourceRef = useRef(source);
  useEffect(() => {
    if (prevSourceRef.current !== source) {
      setScrollOffset(0);
      prevSourceRef.current = source;
    }
  }, [source]);

  const viewportLines =
    hasMeasured && height > 0
      ? Math.max(MIN_VIEWPORT_LINES, height)
      : lineCount;

  const pageStep = Math.max(1, Math.floor(viewportLines / 2));

  // Bounds ref so command callbacks stay identity-stable across line
  // arrival (mirrors `WorkerOutputView`'s pattern).
  const boundsRef = useRef({ lineCount, viewportLines });
  boundsRef.current = { lineCount, viewportLines };

  useInput(
    (_, key) => {
      if (key.pageUp) {
        setScrollOffset((prev) => {
          const { lineCount: lc, viewportLines: vl } = boundsRef.current;
          const max = Math.max(0, lc - vl);
          return Math.min(max, prev + pageStep);
        });
        return;
      }
      if (key.pageDown) {
        setScrollOffset((prev) => Math.max(0, prev - pageStep));
        return;
      }
      if (key.end) {
        setScrollOffset(0);
        return;
      }
    },
    { isActive: isFocused },
  );

  const jumpTop = useCallback(() => {
    const { lineCount: lc, viewportLines: vl } = boundsRef.current;
    setScrollOffset(Math.max(0, lc - vl));
  }, []);

  const jumpBottom = useCallback(() => {
    setScrollOffset(0);
  }, []);

  const lineDown = useCallback(() => {
    setScrollOffset((prev) => Math.max(0, prev - 1));
  }, []);

  const lineUp = useCallback(() => {
    setScrollOffset((prev) => {
      const { lineCount: lc, viewportLines: vl } = boundsRef.current;
      const max = Math.max(0, lc - vl);
      return Math.min(max, prev + 1);
    });
  }, []);

  const commands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'diff.jumpTop',
        title: 'top',
        key: { kind: 'char', char: 'g' },
        scope: 'output',
        displayOnScreen: true,
        onSelect: jumpTop,
      },
      {
        id: 'diff.jumpBottom',
        title: 'bottom',
        key: { kind: 'char', char: 'G' },
        scope: 'output',
        displayOnScreen: true,
        onSelect: jumpBottom,
      },
      {
        id: 'diff.lineDown',
        title: 'down',
        key: { kind: 'char', char: 'j' },
        scope: 'output',
        displayOnScreen: false,
        onSelect: lineDown,
      },
      {
        id: 'diff.lineUp',
        title: 'up',
        key: { kind: 'char', char: 'k' },
        scope: 'output',
        displayOnScreen: false,
        onSelect: lineUp,
      },
    ],
    [jumpTop, jumpBottom, lineUp, lineDown],
  );

  const { config } = useConfig();
  const overriddenCommands = useMemo(
    () => applyKeybindOverrides(commands, config.keybindOverrides),
    [commands, config.keybindOverrides],
  );
  useRegisterCommands(overriddenCommands, isFocused);

  const end = Math.max(0, lineCount - scrollOffset);
  const start = Math.max(0, end - viewportLines);
  const visible = lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = scrollOffset;
  const hasOverflow = hiddenAbove > 0 || hiddenBelow > 0;

  return (
    <Box ref={ref} flexGrow={1} flexDirection="column">
      {hasOverflow ? (
        <Text color={theme['textMuted']}>
          {scrollHintText(hiddenAbove, hiddenBelow)}
        </Text>
      ) : null}
      {visible.map((line, idx) => (
        <Text key={`${start + idx}::${line.kind}`} color={diffColor(theme, line.kind)}>
          {line.text.length === 0 ? ' ' : line.text}
        </Text>
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

function diffColor(theme: Record<string, string>, kind: DiffLineKind): string {
  switch (kind) {
    case 'add':
      return theme['diffAdd']!;
    case 'remove':
      return theme['diffRemove']!;
    case 'hunk':
      return theme['diffHunk']!;
    case 'meta':
      return theme['diffMeta']!;
    case 'context':
      return theme['diffContext']!;
  }
}
