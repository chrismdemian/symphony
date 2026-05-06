import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import os from 'node:os';
import path from 'node:path';
import { useTheme } from '../../theme/context.js';
import { useFocus } from '../../focus/focus.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import { useConfig } from '../../../utils/config-context.js';
import { useToast } from '../../feedback/ToastProvider.js';
import type { SymphonyConfig } from '../../../utils/config-schema.js';

/**
 * Phase 3H.1 — read-only settings popup.
 *
 * Layout pattern from `<Palette>` (`src/ui/panels/palette/Palette.tsx`):
 * popup-scope `'settings'`, popup-internal navigation commands flagged
 * `internal: true` so the command palette doesn't list them, ref-mirror
 * pattern for selection state to avoid the registry-mutation feedback
 * loop documented in the 3F.1 audit.
 *
 * Sections (header rows are non-selectable):
 *   ── Model ──            modelMode
 *   ── Workers ──          maxConcurrentWorkers
 *   ── Appearance ──       theme.name, theme.autoFallback16Color
 *   ── Notifications ──    notifications.enabled
 *   ── Project ──          defaultProjectPath
 *   ── Advanced ──         leaderTimeoutMs, schemaVersion, keybindOverrides count
 *
 * In 3H.1 every value is read-only. Pressing Enter on a value row shows
 * a toast "Editing ships in 3H.2." — discoverable signal that the row
 * IS interactive, just not yet. 3H.2 swaps the toast for the inline
 * edit affordance per the field's type.
 *
 * The footer line shows the source (file path or "(no file — using
 * defaults)") so the user can see exactly where their config lives. If
 * the loader emitted warnings, the toast tray surfaces them on mount —
 * the popup doesn't repeat them.
 */

const SCOPE = 'settings';
// 17 rows = the full layout (6 section headers + 11 value rows). Keeping
// the popup body taller than the strict default 14 of Palette because
// the rows here are denser (label + value + tag) and we WANT every field
// visible without scrolling — the popup is a reference card more than a
// scrollable list.
const VISIBLE_ROWS = 18;

type Row =
  | { readonly kind: 'header'; readonly label: string }
  | {
      readonly kind: 'value';
      readonly label: string;
      readonly value: string;
      readonly source: 'default' | 'file';
      readonly description?: string;
    };

export function SettingsPanel(): React.JSX.Element {
  const theme = useTheme();
  const focus = useFocus();
  const { config, source, reload } = useConfig();
  const { showToast } = useToast();
  const isFocused = focus.currentScope === SCOPE;

  // Reload on every popup mount so users who ran `symphony config
  // --edit` (or otherwise changed the file out-of-band) see the fresh
  // values. Idempotent — `reload` is a no-op if no file change happened.
  // Hot-reload via `fs.watch` is the 3H.2 upgrade path.
  useEffect(() => {
    void reload();
  }, [reload]);

  const rows = useMemo(() => buildRows(config, source), [config, source]);

  // Default selection lands on the first selectable (value) row.
  const firstSelectable = useMemo(() => rows.findIndex((r) => r.kind === 'value'), [rows]);
  const [selectedIdx, setSelectedIdx] = useState(firstSelectable === -1 ? 0 : firstSelectable);

  // Ref-mirrors so popupCommands' onSelect closures read live state
  // without registry feedback loops (3F.1 audit pattern).
  const rowsRef = useRef(rows);
  const selectedIdxRef = useRef(selectedIdx);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    selectedIdxRef.current = selectedIdx;
  }, [selectedIdx]);

  const popPopup = focus.popPopup;

  const move = useCallback((delta: 1 | -1): void => {
    const list = rowsRef.current;
    if (list.length === 0) return;
    setSelectedIdx((idx) => {
      const start = Math.min(Math.max(idx, 0), list.length - 1);
      let next = start;
      for (let step = 0; step < list.length; step += 1) {
        next = (next + delta + list.length) % list.length;
        if (list[next]?.kind === 'value') return next;
      }
      return start;
    });
  }, []);

  const handleEnter = useCallback((): void => {
    const row = rowsRef.current[selectedIdxRef.current];
    if (row === undefined || row.kind !== 'value') return;
    showToast('Editing ships in Phase 3H.2.', { tone: 'info' });
  }, [showToast]);

  const popupCommands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'settings.dismiss',
        title: 'close',
        key: { kind: 'escape' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => popPopup(),
      },
      {
        id: 'settings.next',
        title: 'next',
        key: { kind: 'downArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => move(1),
      },
      {
        id: 'settings.prev',
        title: 'prev',
        key: { kind: 'upArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => move(-1),
      },
      {
        id: 'settings.invoke',
        title: 'edit (3H.2)',
        key: { kind: 'return' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: handleEnter,
      },
    ],
    [popPopup, move, handleEnter],
  );

  useRegisterCommands(popupCommands, isFocused);

  const sourceLine = useMemo(() => formatSourceLine(source), [source]);
  const visible = useMemo(() => sliceVisible(rows, selectedIdx), [rows, selectedIdx]);

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
          Settings
        </Text>
        <Text color={theme['textMuted']}>
          {' '}
          · Phase 3H.1 (read-only)
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.rows.length === 0 ? (
          <Text color={theme['textMuted']}>(no settings)</Text>
        ) : (
          visible.rows.map((row, offset) => {
            const absoluteIdx = visible.start + offset;
            return (
              <SettingsRow
                key={`${row.kind}-${absoluteIdx}`}
                row={row}
                selected={absoluteIdx === selectedIdx}
                theme={theme}
              />
            );
          })
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme['textMuted']}>{sourceLine}</Text>
        <Text color={theme['textMuted']}>
          ↑↓ navigate · Enter edit (3H.2) · Esc close
        </Text>
      </Box>
    </Box>
  );
}

interface SettingsRowProps {
  readonly row: Row;
  readonly selected: boolean;
  readonly theme: Record<string, string>;
}

function SettingsRow({ row, selected, theme }: SettingsRowProps): React.JSX.Element {
  if (row.kind === 'header') {
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color={theme['textMuted']}>── </Text>
        <Text color={theme['textMuted']} bold>
          {row.label}
        </Text>
        <Text color={theme['textMuted']}> ──</Text>
      </Box>
    );
  }
  const marker = selected ? '▸ ' : '  ';
  const valueColor =
    row.source === 'file' ? theme['accent'] ?? theme['text']! : theme['text']!;
  const sourceTag = row.source === 'file' ? '(from file)' : '(default)';
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" width="100%">
        {/*
         * Layout: marker + label (natural width) → spacer
         * (`flexGrow=1`) → value + tag (natural width). Explicit
         * `width="100%"` on the row forces it to the popup's content
         * width so the spacer has space to claim. Without that, rows
         * containing only natural-width children render at content
         * width, and rows containing the spacer claim more, producing
         * a ragged right border (visible in the visual harness output
         * when the row width exceeds the natural-width header rows).
         */}
        <Text color={selected ? theme['accent'] : theme['textMuted']}>{marker}</Text>
        <Text color={theme['text']}>{row.label}</Text>
        <Box flexGrow={1} />
        <Text color={valueColor}>{row.value}</Text>
        <Text color={theme['textMuted']}>{` ${sourceTag}`}</Text>
      </Box>
      {selected && row.description !== undefined ? (
        <Box flexDirection="row" width="100%">
          <Text color={theme['textMuted']}>    {row.description}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function buildRows(
  config: SymphonyConfig,
  source: { readonly kind: 'default' } | { readonly kind: 'file'; readonly path: string },
): readonly Row[] {
  // 3H.1 simplification: we don't have per-field source data from the
  // loader (that would require tracking which keys were present pre-
  // schema-defaults). The "from file" tag is therefore ALL-OR-NOTHING
  // at the file level today. 3H.2 augments `LoadResult` with a
  // `presentKeys: ReadonlySet<string>` so per-field source can be
  // surfaced accurately. For 3H.1 readers, "from file" means "the file
  // exists; this value either matches or was salvaged" — accurate
  // enough for the read-only display contract.
  const fromFileSource: 'default' | 'file' = source.kind === 'file' ? 'file' : 'default';

  return [
    { kind: 'header', label: 'Model' },
    {
      kind: 'value',
      label: 'modelMode',
      value: config.modelMode,
      source: fromFileSource,
      description: 'opus = all workers run Opus · mixed = orchestrator picks per task',
    },
    { kind: 'header', label: 'Workers' },
    {
      kind: 'value',
      label: 'maxConcurrentWorkers',
      value: String(config.maxConcurrentWorkers),
      source: fromFileSource,
      description: 'Phase 3H.2 will enforce; today this is a display-only field',
    },
    { kind: 'header', label: 'Appearance' },
    {
      kind: 'value',
      label: 'theme.name',
      value: config.theme.name,
      source: fromFileSource,
      description: 'Locked palette (violet + gold). Multi-theme picker is a future phase.',
    },
    {
      kind: 'value',
      label: 'theme.autoFallback16Color',
      value: String(config.theme.autoFallback16Color),
      source: fromFileSource,
      description: 'Probe terminal capability and fall back to 16-color on truecolor-less terminals',
    },
    { kind: 'header', label: 'Notifications' },
    {
      kind: 'value',
      label: 'notifications.enabled',
      value: String(config.notifications.enabled),
      source: fromFileSource,
      description: 'Desktop toast on worker completed/failed/needs-input. Dispatcher ships in 3H.3.',
    },
    { kind: 'header', label: 'Project' },
    {
      kind: 'value',
      label: 'defaultProjectPath',
      value: config.defaultProjectPath ?? '(none)',
      source: fromFileSource,
      description: 'Pre-selected project at `symphony start` when no --project arg is passed',
    },
    { kind: 'header', label: 'Advanced' },
    {
      kind: 'value',
      label: 'leaderTimeoutMs',
      value: String(config.leaderTimeoutMs),
      source: fromFileSource,
      description: 'Window after Ctrl+X for the second key of a leader chord',
    },
    {
      kind: 'value',
      label: 'schemaVersion',
      value: String(config.schemaVersion),
      source: fromFileSource,
      description: 'Internal config-schema version. Future migrations branch on this.',
    },
    {
      kind: 'value',
      label: 'keybindOverrides',
      value: `${Object.keys(config.keybindOverrides).length} entries`,
      source: fromFileSource,
      description: 'Per-command keybind overrides. Edit affordance ships in Phase 3H.4.',
    },
  ];
}

function formatSourceLine(
  source: { readonly kind: 'default' } | { readonly kind: 'file'; readonly path: string },
): string {
  if (source.kind === 'default') return 'Source: (no file — using defaults)';
  return `Source: ${displayPath(source.path)}`;
}

function displayPath(absolute: string): string {
  const home = os.homedir();
  if (absolute === home) return '~';
  // Audit M1 (3H.1 review): `startsWith(home)` alone false-positives
  // when `home === "/home/chris"` and path is `"/home/chrisother/..."`.
  // The next char must be a path separator so we only collapse genuine
  // descendants. POSIX uses `/`; Win32 accepts both `\` and `/`.
  if (absolute.startsWith(home)) {
    const next = absolute.charAt(home.length);
    if (next === path.sep || next === '/') {
      return `~${absolute.slice(home.length)}`;
    }
  }
  return absolute;
}

function sliceVisible(
  rows: readonly Row[],
  selectedIdx: number,
): { readonly start: number; readonly rows: readonly Row[] } {
  if (rows.length <= VISIBLE_ROWS) return { start: 0, rows };
  let start = Math.max(0, selectedIdx - Math.floor(VISIBLE_ROWS / 2));
  const end = Math.min(rows.length, start + VISIBLE_ROWS);
  start = Math.max(0, end - VISIBLE_ROWS);
  return { start, rows: rows.slice(start, end) };
}

