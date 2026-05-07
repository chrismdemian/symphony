import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { useTheme } from '../../theme/context.js';
import { useFocus } from '../../focus/focus.js';
import {
  useKeybinds,
  useRegisterCommands,
} from '../../keybinds/dispatcher.js';
import {
  formatKey,
  selectAllCommands,
  type Command,
} from '../../keybinds/registry.js';
import {
  chordFromInput,
  detectKeybindConflicts,
  describeChord,
  withOverride,
  withoutOverride,
  type KeybindConflict,
} from '../../keybinds/overrides.js';
import { useConfig } from '../../../utils/config-context.js';
import { useToast } from '../../feedback/ToastProvider.js';

/**
 * Phase 3H.4 — Keybind override editor.
 *
 * One component, two focus-scopes:
 *
 *   - `'keybind-list'`    — arrow nav over overridable commands. Enter
 *                           on a row enters capture mode by pushing
 *                           `'keybind-capture'` onto the focus stack.
 *                           `r` resets the selected row's override.
 *                           Esc pops back to the parent (settings) popup.
 *   - `'keybind-capture'` — local `useInput` captures the next keystroke
 *                           as a chord. Esc cancels back to list mode.
 *                           Modifier-only / unsupported keystrokes show
 *                           an inline error and stay in capture mode for
 *                           a retry. On valid keystroke: conflict-check
 *                           against the full registry; on success, write
 *                           via `setConfig` and pop back to list.
 *
 * Both scopes route to this component via `Layout.renderPopup`. React
 * keeps the component mounted across the scope transition (same JSX
 * element identity), so component-level state — including the
 * `capturingId` and the `lastError` from a previous attempt — survives
 * a list↔capture cycle.
 *
 * Internal popup-nav commands (`internal: true`) are excluded from the
 * editor entirely (popup Esc/Enter/arrows are sacred). Leader chords
 * appear in the list but Enter on a leader row toasts the deferred
 * notice — multi-keystroke capture is not supported in 3H.4.
 *
 * Reference patterns:
 *   - List nav + Enter-invoke: `<Palette>` (`Palette.tsx`).
 *   - Single-component multi-mode: `<SettingsPanel>` editing-int / text.
 *   - Modifier-only rejection: emdash `KeyboardSettingsCard.tsx:140-202`.
 */

const LIST_SCOPE = 'keybind-list';
const CAPTURE_SCOPE = 'keybind-capture';
const VISIBLE_ROWS = 14;

interface ListRow {
  readonly cmd: Command;
  readonly isOverride: boolean;
}

export function KeybindEditorPopup(): React.JSX.Element {
  const theme = useTheme();
  const focus = useFocus();
  const { commands } = useKeybinds();
  const { config, setConfig } = useConfig();
  const { showToast } = useToast();

  const scope = focus.currentScope;
  const inListMode = scope === LIST_SCOPE;
  const inCaptureMode = scope === CAPTURE_SCOPE;

  // Build the list view from the dispatcher's full registry. Already
  // override-applied (App.tsx + panels run `applyKeybindOverrides` at
  // command-construction sites), so `cmd.key` is the effective chord
  // the user sees. Cross-reference against `config.keybindOverrides`
  // to label `(override)` vs `(default)`.
  const overrides = config.keybindOverrides;
  const rows = useMemo<readonly ListRow[]>(() => {
    const all = selectAllCommands(commands).filter((c) => c.internal !== true);
    const seen: ListRow[] = [];
    for (const cmd of all) {
      seen.push({ cmd, isOverride: overrides[cmd.id] !== undefined });
    }
    // Stable sort: scope (global → main → specific), then title.
    seen.sort((a, b) => {
      const sa = scopeRank(a.cmd.scope);
      const sb = scopeRank(b.cmd.scope);
      if (sa !== sb) return sa - sb;
      return a.cmd.title.localeCompare(b.cmd.title);
    });
    return seen;
  }, [commands, overrides]);

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  // committingRef serializes the capture commit's async write so a
  // second keystroke during the disk hop doesn't double-fire (mirrors
  // SettingsPanel's audit M1/M2 mutex).
  const committingRef = useRef(false);
  // Audit Critical-1 gate: when a list-mode Enter pushes capture mode
  // and the same Enter keystroke is delivered to BOTH the dispatcher
  // (fires beginCapture) AND the just-activated capture useInput
  // (would commit Enter as the new chord), the second delivery happens
  // within ~16ms of arming. Reject any keystroke received within the
  // arming window to break the double-fire. 50ms is a safe envelope —
  // human key-release after press is >100ms; concurrent-mode dispatch
  // is sub-frame.
  const armedAtRef = useRef<number>(0);
  const ARMING_WINDOW_MS = 50;
  // Audit Critical-2: read the FRESH commands list at conflict-check
  // time, not the closure snapshot from useCallback. Worker spawns
  // mid-capture would otherwise leave the closed-over list stale.
  const commandsRef = useRef(commands);
  useEffect(() => {
    commandsRef.current = commands;
  }, [commands]);
  // Audit Major-3: track unmount so async setState calls (setLastError /
  // setCapturingId) post-disk-write don't fire on a dead component
  // when the user closes the popup mid-flight. Mirrors WorkerPanel's
  // unmountedRef pattern.
  const disposedRef = useRef(false);
  useEffect(() => {
    return () => {
      disposedRef.current = true;
    };
  }, []);

  const rowsRef = useRef(rows);
  const selectedIdxRef = useRef(selectedIdx);
  const capturingIdRef = useRef(capturingId);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    selectedIdxRef.current = selectedIdx;
  }, [selectedIdx]);
  useEffect(() => {
    capturingIdRef.current = capturingId;
  }, [capturingId]);

  // Clamp selection if the list shrinks (e.g. registry mutates while
  // the popup is open).
  useEffect(() => {
    if (selectedIdx >= rows.length) {
      setSelectedIdx(Math.max(0, rows.length - 1));
    }
  }, [rows.length, selectedIdx]);

  const popPopup = focus.popPopup;
  const pushPopup = focus.pushPopup;

  const move = useCallback((delta: 1 | -1): void => {
    const list = rowsRef.current;
    if (list.length <= 1) return;
    setSelectedIdx((idx) => {
      const start = Math.min(Math.max(idx, 0), list.length - 1);
      return (start + delta + list.length) % list.length;
    });
  }, []);

  /**
   * Begin capture for the selected row. Leader chords + unbindable
   * commands surface a toast and stay in list mode.
   *
   * Audit Major-1: `unbindable: true` commands (Ctrl+C exit, Tab
   * focus-cycle) are listed for awareness but capture is refused so
   * the user can't brick the launcher's only kill switch.
   */
  const beginCapture = useCallback((): void => {
    const row = rowsRef.current[selectedIdxRef.current];
    if (row === undefined) return;
    if (row.cmd.unbindable === true) {
      showToast(
        `${row.cmd.title} cannot be rebound — it is reserved by the launcher.`,
        { tone: 'info', ttlMs: 5_000 },
      );
      return;
    }
    if (row.cmd.key.kind === 'leader') {
      showToast(
        'Leader chords are not editable here — edit `~/.symphony/config.json` directly.',
        { tone: 'info', ttlMs: 5_000 },
      );
      return;
    }
    setLastError(null);
    setCapturingId(row.cmd.id);
    armedAtRef.current = Date.now();
    pushPopup(CAPTURE_SCOPE);
  }, [pushPopup, showToast]);

  /**
   * Reset the selected row's override (palette command + 'r' key).
   */
  const resetSelected = useCallback(async (): Promise<void> => {
    const row = rowsRef.current[selectedIdxRef.current];
    if (row === undefined) return;
    if (!row.isOverride) {
      showToast(`${row.cmd.title} is already at default.`, { tone: 'info' });
      return;
    }
    try {
      await setConfig((current) => ({
        keybindOverrides: withoutOverride(current.keybindOverrides, row.cmd.id),
      }));
      showToast(`Reset ${row.cmd.title} to default.`, { tone: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Reset failed: ${msg}`, { tone: 'error' });
    }
  }, [setConfig, showToast]);

  const cancelCapture = useCallback((): void => {
    setCapturingId(null);
    setLastError(null);
    popPopup();
  }, [popPopup]);

  /**
   * Commit a captured chord. Conflict-check against the FULL registry
   * (post-override) and refuse if non-empty. On success: write override,
   * pop capture scope, return to list. The capture scope's local
   * `useInput` is the only entry point.
   */
  const commitCapture = useCallback(
    async (input: string, key: Key): Promise<void> => {
      if (committingRef.current) return;
      // Audit Critical-1: reject keystrokes received within the arming
      // window so the same Enter that opened capture can't double-fire
      // as the new chord. Esc passes through (cancel intent).
      if (!key.escape && Date.now() - armedAtRef.current < ARMING_WINDOW_MS) {
        return;
      }
      const id = capturingIdRef.current;
      if (id === null) return;
      const row = rowsRef.current.find((r) => r.cmd.id === id);
      if (row === undefined) {
        cancelCapture();
        return;
      }
      // Esc → cancel. Caller already routes Esc through dispatcher
      // command, but defense-in-depth: if Esc somehow lands here, treat
      // it as cancel rather than capturing it as a chord.
      if (key.escape) {
        cancelCapture();
        return;
      }
      const result = chordFromInput(input, key);
      if (!result.ok) {
        if (!disposedRef.current) setLastError(result.reason);
        return;
      }
      // Audit Critical-2: read the FRESH dispatcher command list via
      // ref so worker-spawn-during-capture doesn't leave a stale
      // closed-over list.
      const liveCommands = commandsRef.current;
      // Conflict detection — use the dispatcher's live command list
      // which already has overrides applied. Excluding internal
      // commands matches the editor's listed scope.
      const conflicts = detectKeybindConflicts(
        liveCommands.filter((c) => c.internal !== true),
        id,
        result.chord,
        row.cmd.scope,
      );
      if (conflicts.length > 0) {
        const first = conflicts[0]!;
        const msg = formatConflictMessage(first);
        if (!disposedRef.current) setLastError(msg);
        return;
      }
      // Audit Major-2: set the mutex BEFORE the await, even though
      // the synchronous validation chain above is fast — defense in
      // depth against rapid double-press.
      committingRef.current = true;
      try {
        await setConfig((current) => ({
          keybindOverrides: withOverride(
            current.keybindOverrides,
            id,
            result.chord,
          ),
        }));
        showToast(
          `Bound "${row.cmd.title}" to ${describeChord(result.chord)}.`,
          { tone: 'success' },
        );
        // Audit Major-3: skip setState calls if the popup unmounted
        // mid-flight. setConfig itself is async and the user may
        // close (Esc to cancel) the popup before the disk write
        // resolves; React 19 flags setState on dead components.
        if (!disposedRef.current) {
          setCapturingId(null);
          setLastError(null);
          popPopup();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!disposedRef.current) setLastError(`Save failed: ${msg}`);
      } finally {
        committingRef.current = false;
      }
    },
    [popPopup, setConfig, showToast, cancelCapture],
  );

  // List-scope commands (Esc/↑/↓/Enter/r). Registered when in list mode.
  const listCommands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'keybind-list.dismiss',
        title: 'close',
        key: { kind: 'escape' },
        scope: LIST_SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => popPopup(),
      },
      {
        id: 'keybind-list.next',
        title: 'next',
        key: { kind: 'downArrow' },
        scope: LIST_SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => move(1),
      },
      {
        id: 'keybind-list.prev',
        title: 'prev',
        key: { kind: 'upArrow' },
        scope: LIST_SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => move(-1),
      },
      {
        id: 'keybind-list.invoke',
        title: 'edit',
        key: { kind: 'return' },
        scope: LIST_SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: beginCapture,
      },
      {
        id: 'keybind-list.reset',
        title: 'reset',
        key: { kind: 'char', char: 'r' },
        scope: LIST_SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          void resetSelected();
        },
      },
    ],
    [popPopup, move, beginCapture, resetSelected],
  );
  useRegisterCommands(listCommands, inListMode);

  // Capture-scope commands — Esc cancels. Every other keystroke is
  // captured by the local `useInput` below.
  const captureCommands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'keybind-capture.cancel',
        title: 'cancel',
        key: { kind: 'escape' },
        scope: CAPTURE_SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: cancelCapture,
      },
    ],
    [cancelCapture],
  );
  useRegisterCommands(captureCommands, inCaptureMode);

  // Local capture listener. Active ONLY while in capture mode. Esc is
  // handled by the dispatcher (above) so it never reaches here. Every
  // other keystroke is a candidate chord.
  useInput(
    (input, key) => {
      if (committingRef.current) return;
      void commitCapture(input, key);
    },
    { isActive: inCaptureMode },
  );

  if (inCaptureMode) {
    const targetRow = rows.find((r) => r.cmd.id === capturingId);
    return (
      <CaptureView
        target={targetRow?.cmd.title ?? '(unknown)'}
        currentChord={
          targetRow !== undefined ? formatKey(targetRow.cmd.key) : '(none)'
        }
        error={lastError}
        theme={theme}
      />
    );
  }
  return (
    <ListView
      rows={rows}
      selectedIdx={selectedIdx}
      theme={theme}
    />
  );
}

function formatConflictMessage(first: KeybindConflict): string {
  const scopeLabel = first.scope === 'global'
    ? 'global'
    : first.scope === 'main'
      ? 'main panels'
      : String(first.scope);
  return `Conflicts with "${first.title}" (${scopeLabel}). Pick a different key.`;
}

function scopeRank(scope: string): number {
  if (scope === 'global') return 0;
  if (scope === 'main') return 1;
  return 2;
}

interface ListViewProps {
  readonly rows: readonly ListRow[];
  readonly selectedIdx: number;
  readonly theme: Record<string, string>;
}

function ListView({ rows, selectedIdx, theme }: ListViewProps): React.JSX.Element {
  const visible = useMemo(
    () => sliceVisible(rows, selectedIdx, VISIBLE_ROWS),
    [rows, selectedIdx],
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
          Keybind editor
        </Text>
        <Text color={theme['textMuted']}>
          {' '}
          · {rows.length} commands
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {rows.length === 0 ? (
          <Text color={theme['textMuted']}>(no overridable commands)</Text>
        ) : (
          visible.rows.map((row, offset) => {
            const idx = visible.start + offset;
            return (
              <KeybindRow
                key={row.cmd.id}
                row={row}
                selected={idx === selectedIdx}
                theme={theme}
              />
            );
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme['textMuted']}>
          ↑↓ navigate · Enter capture new key · r reset · Esc close
        </Text>
      </Box>
    </Box>
  );
}

interface KeybindRowProps {
  readonly row: ListRow;
  readonly selected: boolean;
  readonly theme: Record<string, string>;
}

function KeybindRow({ row, selected, theme }: KeybindRowProps): React.JSX.Element {
  const marker = selected ? '▸ ' : '  ';
  const titleColor = theme['text'] ?? '';
  const tag = row.cmd.unbindable === true
    ? '(reserved)'
    : row.isOverride
      ? '(override)'
      : '(default)';
  const tagColor = row.cmd.unbindable === true
    ? theme['textMuted']
    : row.isOverride
      ? theme['accent']
      : theme['textMuted'];
  const keyText = formatKey(row.cmd.key);
  const scopeBadge = row.cmd.scope === 'global'
    ? ''
    : row.cmd.scope === 'main'
      ? '[main]'
      : `[${String(row.cmd.scope)}]`;
  return (
    <Box flexDirection="row" width="100%">
      <Text color={selected ? theme['accent'] : theme['textMuted']}>{marker}</Text>
      <Text color={titleColor}>{row.cmd.title}</Text>
      <Text color={theme['textMuted']}> {scopeBadge}</Text>
      <Box flexGrow={1} />
      <Text color={row.isOverride ? theme['accent'] : titleColor}>
        {keyText !== '' ? keyText : '(none)'}
      </Text>
      <Text color={tagColor}>{` ${tag}`}</Text>
    </Box>
  );
}

interface CaptureViewProps {
  readonly target: string;
  readonly currentChord: string;
  readonly error: string | null;
  readonly theme: Record<string, string>;
}

function CaptureView({
  target,
  currentChord,
  error,
  theme,
}: CaptureViewProps): React.JSX.Element {
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
          Capture key
        </Text>
        <Text color={theme['textMuted']}>
          {' '}
          · {target}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text color={theme['textMuted']}>Current: </Text>
          <Text color={theme['text']}>{currentChord !== '' ? currentChord : '(none)'}</Text>
        </Box>
        <Box flexDirection="row" marginTop={1}>
          <Text color={theme['accent']} bold>
            Press a key…
          </Text>
        </Box>
        {error !== null ? (
          <Box flexDirection="row" marginTop={1}>
            <Text color={theme['error'] ?? theme['accent']}>{error}</Text>
          </Box>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text color={theme['textMuted']}>Esc to cancel</Text>
      </Box>
    </Box>
  );
}

function sliceVisible<T>(
  rows: readonly T[],
  selectedIdx: number,
  size: number,
): { readonly start: number; readonly rows: readonly T[] } {
  if (rows.length <= size) return { start: 0, rows };
  let start = Math.max(0, selectedIdx - Math.floor(size / 2));
  const end = Math.min(rows.length, start + size);
  start = Math.max(0, end - size);
  return { start, rows: rows.slice(start, end) };
}
