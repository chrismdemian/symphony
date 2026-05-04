import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import fuzzysort from 'fuzzysort';
import { useTheme } from '../../theme/context.js';
import { useFocus, type FocusKey } from '../../focus/focus.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import type { WorkerRecordSnapshot } from '../../../orchestrator/worker-registry.js';
import { useWorkerSelection } from '../../data/WorkerSelection.js';
import { useInstrumentNames } from '../../data/useInstrumentNames.js';

/**
 * Phase 3F.1 — worker selector popup ("/w <name>" deferred from 3C).
 *
 * Mounted by `<Layout>` when the focus stack has a popup with key
 * `'worker-select'` on top. Lists every worker fuzzy-filtered by typed
 * query, matching against `featureIntent`, instrument name, and id.
 *
 * Selecting a row sets `useWorkerSelection`'s `selectedId`, switches
 * the main focus to the workers panel, and closes the popup.
 *
 * Pattern mirrors `Palette.tsx` exactly — local `useInput` for char
 * buffering, registered popup-scope commands for Esc/Enter/arrows.
 */

const SCOPE = 'worker-select';
const VISIBLE_ROWS = 10;
const TARGET_PANEL: FocusKey = 'workers';

export interface WorkerSelectorProps {
  readonly workers: readonly WorkerRecordSnapshot[];
}

interface Row {
  readonly worker: WorkerRecordSnapshot;
  readonly instrument: string | undefined;
  readonly haystack: string;
  readonly indexes: readonly number[];
  readonly score: number;
}

export function WorkerSelector({ workers }: WorkerSelectorProps): React.JSX.Element {
  const theme = useTheme();
  const focus = useFocus();
  const isFocused = focus.currentScope === SCOPE;
  const selection = useWorkerSelection();
  const instruments = useInstrumentNames(workers);
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  const rows = useMemo<readonly Row[]>(() => {
    const records = workers.map((w) => {
      const instrument = instruments.get(w.id);
      const haystack = [
        instrument ?? '',
        w.featureIntent,
        w.role,
        w.id,
      ]
        .filter((s) => s.length > 0)
        .join(' · ');
      return { worker: w, instrument, haystack };
    });
    if (filter.trim() === '') {
      return records.map((r) => ({
        worker: r.worker,
        instrument: r.instrument,
        haystack: r.haystack,
        indexes: [],
        score: 1,
      }));
    }
    const results = fuzzysort.go(filter.trim(), records, {
      key: 'haystack',
      limit: 50,
      threshold: 0,
    });
    return results.map((r) => ({
      worker: r.obj.worker,
      instrument: r.obj.instrument,
      haystack: r.obj.haystack,
      indexes: Array.from(r.indexes),
      score: r.score,
    }));
  }, [workers, instruments, filter]);

  const clampedIdx = rows.length === 0 ? 0 : Math.min(selectedIdx, rows.length - 1);

  // Refs mirror live state so popupCommands stays identity-stable —
  // see Palette.tsx for the full rationale (registry-mutation feedback
  // loop). Same pattern, same hazard.
  const rowsRef = useRef(rows);
  const clampedIdxRef = useRef(clampedIdx);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    clampedIdxRef.current = clampedIdx;
  }, [clampedIdx]);

  const popPopup = focus.popPopup;
  const popAndSetMain = focus.popAndSetMain;
  const invokeRow = useCallback(
    (row: Row): void => {
      selection.setSelectedId(row.worker.id);
      // Phase 3F.1 audit M2: a previous version did `popPopup();
      // setMain(TARGET_PANEL)` as two separate dispatches. Both reducer
      // calls read pre-batch state, so when `setMain` ran the popup
      // was still on top → the audit-M6 guard at `focus.tsx:96-98`
      // silently swallowed it, and the worker selector "select +
      // switch panel" was actually "select; user remained in chat".
      // The atomic `popAndSetMain` action computes the new stack in
      // a single reducer pass.
      popAndSetMain(TARGET_PANEL);
    },
    [selection, popAndSetMain],
  );

  const move = useCallback((delta: 1 | -1): void => {
    const list = rowsRef.current;
    if (list.length <= 1) return;
    setSelectedIdx((idx) => {
      const start = Math.min(idx, list.length - 1);
      const next = (start + delta + list.length) % list.length;
      return next;
    });
  }, []);

  const popupCommands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'worker-select.dismiss',
        title: 'close',
        key: { kind: 'escape' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => popPopup(),
      },
      {
        id: 'worker-select.invoke',
        title: 'select worker',
        key: { kind: 'return' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          const list = rowsRef.current;
          const idx = clampedIdxRef.current;
          const r = list[idx];
          if (r === undefined) return;
          invokeRow(r);
        },
      },
      {
        id: 'worker-select.next',
        title: 'next',
        key: { kind: 'downArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => move(1),
      },
      {
        id: 'worker-select.prev',
        title: 'prev',
        key: { kind: 'upArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => move(-1),
      },
    ],
    [popPopup, invokeRow, move],
  );

  useRegisterCommands(popupCommands, isFocused);

  // Audit M4 — full negative whitelist mirroring InputBar.
  useInput(
    (input, key) => {
      if (key.return || key.escape) return;
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (key.tab) return;
      if (key.pageUp || key.pageDown || key.home || key.end) return;
      if (key.ctrl || key.meta) return;
      if (key.backspace || key.delete) {
        setFilter((prev) => prev.slice(0, -1));
        setSelectedIdx(0);
        return;
      }
      if (input.length >= 1) {
        setFilter((prev) => prev + input);
        setSelectedIdx(0);
      }
    },
    { isActive: isFocused },
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
          Select worker
        </Text>
        <Text color={theme['textMuted']}>
          {' '}
          · {rows.length} of {workers.length}
        </Text>
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Text color={theme['textMuted']}>{'> '}</Text>
        <Text color={theme['text']}>{filter}</Text>
        <Text color={theme['textMuted']} inverse>
          {' '}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <Text color={theme['textMuted']}>(no workers match)</Text>
        ) : (
          renderRows(rows, clampedIdx, theme)
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme['textMuted']}>
          ↑↓ to navigate · Enter to select · Esc to close
        </Text>
      </Box>
    </Box>
  );
}

function renderRows(
  rows: readonly Row[],
  selectedIdx: number,
  theme: Record<string, string>,
): React.JSX.Element[] {
  const total = rows.length;
  const size = VISIBLE_ROWS;
  let start = 0;
  let end = total;
  if (total > size) {
    start = Math.max(0, selectedIdx - Math.floor(size / 2));
    end = Math.min(total, start + size);
    start = Math.max(0, end - size);
  }
  const out: React.JSX.Element[] = [];
  for (let i = start; i < end; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    out.push(<WorkerRow key={row.worker.id} row={row} selected={i === selectedIdx} theme={theme} />);
  }
  return out;
}

interface WorkerRowProps {
  readonly row: Row;
  readonly selected: boolean;
  readonly theme: Record<string, string>;
}

function WorkerRow({ row, selected, theme }: WorkerRowProps): React.JSX.Element {
  const marker = selected ? '▸ ' : '  ';
  const set = new Set(row.indexes);
  const chars: React.JSX.Element[] = [];
  for (let i = 0; i < row.haystack.length; i++) {
    const ch = row.haystack[i]!;
    if (set.has(i)) {
      chars.push(
        <Text key={i} color={theme['accent']} bold>
          {ch}
        </Text>,
      );
    } else {
      chars.push(
        <Text key={i} color={theme['text']}>
          {ch}
        </Text>,
      );
    }
  }
  return (
    <Box flexDirection="row">
      <Text color={selected ? theme['accent'] : theme['textMuted']}>{marker}</Text>
      <Box flexGrow={1}>
        <Text>{chars}</Text>
      </Box>
      <Text color={theme['textMuted']}>{'  '}{row.worker.status}</Text>
    </Box>
  );
}
