import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../theme/context.js';
import { useFocus } from '../../focus/focus.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import type { TuiRpc } from '../../runtime/rpc.js';
import type { AuditEntry } from '../../../state/audit-store.js';
import { auditGlyphFor, type AuditTone } from './audit-glyph.js';
import { useAuditLog } from './useAuditLog.js';

/**
 * Phase 3R — `/log` popup. Scrollable audit trail with an inline filter
 * row. Chrome matches DepsPanel / StatsPanel / QuestionHistory:
 *
 *   - Header: title + match count + loading hint
 *   - Filter row: `filter> <text>█` (Palette-style local useInput)
 *   - Parse-error / unknown-project warning rows (muted/red)
 *   - Day-divider grouped rows: `── Wed May 14 ──`
 *   - Each row: `HH:MM:SS  glyph  kind            headline`
 *   - Footer: keybind hints
 *
 * Scroll via ↑/↓ (registered commands; the local filter input rejects
 * arrows). Ctrl+U clears the filter. Esc closes. 2s poll cadence.
 */

const SCOPE = 'log';
const VISIBLE_ROWS = 14;
const KIND_COL = 18;

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function hhmmss(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dayLabel(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown date';
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function dayKey(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export interface LogPanelProps {
  readonly rpc: TuiRpc;
}

export function LogPanel({ rpc }: LogPanelProps): React.JSX.Element {
  const theme = useTheme();
  const focus = useFocus();
  const isFocused = focus.currentScope === SCOPE;
  const popPopup = focus.popPopup;
  const log = useAuditLog(rpc, isFocused);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const count = log.entries.length;
  const clampedIdx = count === 0 ? 0 : Math.min(selectedIdx, count - 1);
  const countRef = useRef(count);
  useEffect(() => {
    countRef.current = count;
  }, [count]);

  const move = useCallback((delta: 1 | -1): void => {
    const total = countRef.current;
    if (total === 0) return;
    setSelectedIdx((idx) => {
      const next = idx + delta;
      if (next < 0) return 0;
      if (next >= total) return total - 1;
      return next;
    });
  }, []);

  const commands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'log.dismiss',
        title: 'close',
        key: { kind: 'escape' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => popPopup(),
      },
      {
        id: 'log.next',
        title: 'next',
        key: { kind: 'downArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => move(1),
      },
      {
        id: 'log.prev',
        title: 'prev',
        key: { kind: 'upArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => move(-1),
      },
      {
        id: 'log.clear',
        title: 'clear filter',
        key: { kind: 'ctrl', char: 'u' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          log.clearFilter();
          setSelectedIdx(0);
        },
      },
    ],
    [popPopup, move, log],
  );
  useRegisterCommands(commands, isFocused);

  // Local input listener for the filter row — mirrors Palette's
  // negative whitelist (InputBar.tsx:167-184). Arrows / Ctrl / meta
  // fall through to the registered scroll + clear commands.
  useInput(
    (input, key) => {
      if (key.return || key.escape) return;
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (key.tab) return;
      if (key.pageUp || key.pageDown || key.home || key.end) return;
      if (key.ctrl || key.meta) return;
      if (key.backspace || key.delete) {
        log.backspaceFilter();
        setSelectedIdx(0);
        return;
      }
      if (input.length >= 1) {
        log.appendFilterChar(input);
        setSelectedIdx(0);
      }
    },
    { isActive: isFocused },
  );

  const toneColor = useCallback(
    (tone: AuditTone): string => {
      switch (tone) {
        case 'success':
          return theme['success']!;
        case 'accent':
          return theme['accent']!;
        case 'warning':
          return theme['warning']!;
        case 'error':
          return theme['error']!;
        case 'muted':
        default:
          return theme['textMuted']!;
      }
    },
    [theme],
  );

  const window = useMemo(() => {
    const total = count;
    if (total <= VISIBLE_ROWS) return { start: 0, end: total };
    let start = Math.max(0, clampedIdx - Math.floor(VISIBLE_ROWS / 2));
    const end = Math.min(total, start + VISIBLE_ROWS);
    start = Math.max(0, end - VISIBLE_ROWS);
    return { start, end };
  }, [count, clampedIdx]);

  const visible: readonly AuditEntry[] = useMemo(
    () => log.entries.slice(window.start, window.end),
    [log.entries, window.start, window.end],
  );

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor={theme['accent']}
      paddingX={1}
    >
      <Box flexDirection="row" marginBottom={0}>
        <Text color={theme['accent']} bold>
          Audit log
        </Text>
        <Text color={theme['textMuted']}>
          {' '}
          · {count} {count === 1 ? 'entry' : 'entries'}
        </Text>
        {log.loading && <Text color={theme['textMuted']}> · loading</Text>}
      </Box>

      <Box flexDirection="row" marginTop={1}>
        <Text color={theme['textMuted']}>{'filter> '}</Text>
        <Text color={theme['text']}>{log.filterText}</Text>
        <Text color={theme['textMuted']} inverse>
          {' '}
        </Text>
      </Box>

      {log.error !== null && (
        <Box marginTop={1}>
          <Text color={theme['error']}>Failed to load audit log: {log.error}</Text>
        </Box>
      )}

      {log.unknownProject !== null && (
        <Box marginTop={1}>
          <Text color={theme['warning']}>
            Unknown project "{log.unknownProject}" — no rows match.
          </Text>
        </Box>
      )}

      {log.parseErrors.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {log.parseErrors.map((e, i) => (
            <Text key={i} color={theme['textMuted']}>
              ⚠ {e}
            </Text>
          ))}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {count === 0 ? (
          <Text color={theme['textMuted']}>
            {log.filterText.trim().length > 0
              ? 'No audit entries match this filter.'
              : 'No audit entries yet. Actions are logged here as they happen.'}
          </Text>
        ) : (
          visible.map((entry, idx) => {
            const absoluteIdx = window.start + idx;
            const prev = absoluteIdx > 0 ? log.entries[absoluteIdx - 1] : undefined;
            const showDivider =
              prev === undefined || dayKey(prev.ts) !== dayKey(entry.ts);
            const { glyph, tone } = auditGlyphFor(entry.kind, entry.severity);
            const selected = absoluteIdx === clampedIdx;
            return (
              <Box key={entry.id} flexDirection="column">
                {showDivider && (
                  <Text color={theme['textMuted']}>
                    ── {dayLabel(entry.ts)} ──
                  </Text>
                )}
                <Box flexDirection="row">
                  <Text color={selected ? theme['accent'] : theme['textMuted']}>
                    {selected ? '▸ ' : '  '}
                  </Text>
                  <Text color={theme['textMuted']}>{hhmmss(entry.ts)} </Text>
                  <Text color={toneColor(tone)}>{glyph} </Text>
                  <Text color={toneColor(tone)}>{pad(entry.kind, KIND_COL)}</Text>
                  <Text color={theme['text']}>{entry.headline}</Text>
                </Box>
              </Box>
            );
          })
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme['textMuted']}>
          ↑↓ scroll · type to filter · Ctrl+U clear · Esc close
        </Text>
      </Box>
    </Box>
  );
}
