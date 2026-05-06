import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { useTheme } from '../../theme/context.js';
import { useFocus } from '../../focus/focus.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import { useConfig } from '../../../utils/config-context.js';
import { useToast } from '../../feedback/ToastProvider.js';
import type { SymphonyConfig } from '../../../utils/config-schema.js';

/**
 * Phase 3H.2 — editable settings popup.
 *
 * Phase 3H.1 shipped a read-only popup. This phase adds inline editors:
 *
 *   - **Bool** (`autoFallback16Color`, `notifications.enabled`):
 *     Space toggles in-place; Enter does the same for consistency.
 *   - **Enum** (`modelMode`): Enter cycles `opus ↔ mixed`.
 *   - **Int** (`maxConcurrentWorkers`, `leaderTimeoutMs`): Enter mounts
 *     a digit-only inline input below the row. Esc cancels; Enter
 *     commits + Zod-validates. Out-of-range → toast + cancel.
 *   - **Text-path** (`defaultProjectPath`): Enter mounts a text input.
 *     On commit, validates `fs.existsSync(path) && exists(<path>/.git)`.
 *     Empty input clears the field via `setConfig({defaultProjectPath: null})`.
 *   - **Readonly** (`theme.name`, `schemaVersion`, `keybindOverrides`):
 *     Enter shows a toast pointing at the future phase (3H.4 for
 *     keybindOverrides; the others are intrinsic / never editable).
 *
 * State machine:
 *   `idle` (arrow nav, Space/Enter dispatches by row kind)
 *   ↓ Enter on int/text row
 *   `editing-int` | `editing-text` (typed buffer; Enter commits, Esc cancels)
 *   ↓ commit success
 *   `idle`
 *
 * Layout pattern from `<Palette>` (`src/ui/panels/palette/Palette.tsx`):
 * popup-scope `'settings'`, popup-internal navigation commands flagged
 * `internal: true`, ref-mirror pattern for selection state to avoid
 * the registry-mutation feedback loop documented in the 3F.1 audit.
 */

const SCOPE = 'settings';
const VISIBLE_ROWS = 18;

type RowKind = 'bool' | 'enum' | 'int' | 'text-path' | 'readonly';

type Row =
  | { readonly kind: 'header'; readonly label: string }
  | {
      readonly kind: 'value';
      readonly label: string;
      readonly value: string;
      readonly source: 'default' | 'file';
      readonly editKind: RowKind;
      readonly description?: string;
    };

/**
 * Active inline-edit sub-state. `idle` means the popup is in navigation
 * mode; the other variants mean the user is mid-edit on a specific
 * field. `value` is the in-progress buffer.
 */
type EditState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'editing-int';
      readonly rowIdx: number;
      readonly field: 'maxConcurrentWorkers' | 'leaderTimeoutMs';
      readonly value: string;
    }
  | {
      readonly kind: 'editing-text';
      readonly rowIdx: number;
      readonly field: 'defaultProjectPath';
      readonly value: string;
    };

export function SettingsPanel(): React.JSX.Element {
  const theme = useTheme();
  const focus = useFocus();
  const { config, source, reload, setConfig } = useConfig();
  const { showToast } = useToast();
  const isFocused = focus.currentScope === SCOPE;

  // Reload on every popup mount so users who ran `symphony config
  // --edit` (or otherwise changed the file out-of-band) see the fresh
  // values. Idempotent — `reload` is a no-op if no file change happened.
  useEffect(() => {
    void reload();
  }, [reload]);

  const rows = useMemo(() => buildRows(config, source), [config, source]);

  const firstSelectable = useMemo(() => rows.findIndex((r) => r.kind === 'value'), [rows]);
  const [selectedIdx, setSelectedIdx] = useState(firstSelectable === -1 ? 0 : firstSelectable);
  const [edit, setEdit] = useState<EditState>({ kind: 'idle' });

  const rowsRef = useRef(rows);
  const selectedIdxRef = useRef(selectedIdx);
  const editRef = useRef(edit);
  // Audit M1/M2: tracks whether a commitEdit is mid-await. While
  // committing, useInput drops chars (so user typing isn't silently
  // discarded by the post-commit setEdit({kind:'idle'})), Esc no-ops
  // (so the user's cancel intent doesn't race with a successful disk
  // write that has ALREADY landed), and the dispatcher's Enter command
  // no-ops (so two Enters in flight don't fire two parallel commits).
  const committingRef = useRef(false);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    selectedIdxRef.current = selectedIdx;
  }, [selectedIdx]);
  useEffect(() => {
    editRef.current = edit;
  }, [edit]);

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

  // Apply a config patch and surface ZodError as a toast. Returns true on
  // success, false on validation rejection. Accepts both static patches
  // and function-patches (audit C2 from commit-5 review): function-
  // patches resolve against the just-committed state inside setConfig's
  // serialized queue, fixing rapid-fire chord double-press regressions.
  const applyPatch = useCallback(
    async (patch: Parameters<typeof setConfig>[0]): Promise<boolean> => {
      try {
        await setConfig(patch);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showToast(`Invalid: ${message}`, { tone: 'error' });
        return false;
      }
    },
    [setConfig, showToast],
  );

  // Toggle a bool row's value. Uses a function-patch so rapid-fire
  // toggles always read the just-committed state (audit C2 from
  // commit-5 review).
  const toggleBool = useCallback(
    (label: string): void => {
      if (label === 'theme.autoFallback16Color') {
        void applyPatch((current) => ({
          theme: { autoFallback16Color: !current.theme.autoFallback16Color },
        }));
        return;
      }
      if (label === 'notifications.enabled') {
        void applyPatch((current) => ({
          notifications: { enabled: !current.notifications.enabled },
        }));
        return;
      }
    },
    [applyPatch],
  );

  // Cycle an enum row.
  const cycleEnum = useCallback(
    (label: string): void => {
      if (label === 'modelMode') {
        void applyPatch((current) => ({
          modelMode: current.modelMode === 'opus' ? 'mixed' : 'opus',
        }));
      }
    },
    [applyPatch],
  );

  // Enter an int-edit mode for the selected row.
  const startIntEdit = useCallback((rowIdx: number, label: string, current: number): void => {
    if (label !== 'maxConcurrentWorkers' && label !== 'leaderTimeoutMs') return;
    setEdit({
      kind: 'editing-int',
      rowIdx,
      field: label,
      value: String(current),
    });
  }, []);

  // Enter a text-edit mode for the selected row.
  const startTextEdit = useCallback((rowIdx: number, label: string, current: string): void => {
    if (label !== 'defaultProjectPath') return;
    setEdit({
      kind: 'editing-text',
      rowIdx,
      field: label,
      value: current,
    });
  }, []);

  // Commit the active edit. Validation depends on the field. Audit M1/M2:
  // a `committingRef` mutex prevents typing-during-await and
  // Esc-during-await from racing the in-flight disk write. The mutex
  // covers ONLY the await window — synchronous local validation runs
  // outside it so rapid Enter on an already-invalid buffer rejects fast.
  const commitEdit = useCallback(async (): Promise<void> => {
    if (committingRef.current) return; // already in flight; idempotent
    const current = editRef.current;
    if (current.kind === 'idle') return;

    // Local validation (fast-fail without touching disk).
    if (current.kind === 'editing-int') {
      const trimmed = current.value.trim();
      if (trimmed.length === 0) {
        showToast('Empty value — aborted', { tone: 'warning' });
        setEdit({ kind: 'idle' });
        return;
      }
      const n = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        showToast(`Invalid integer: ${trimmed}`, { tone: 'error' });
        return; // editor stays open with the bad buffer for fix
      }
      const patch =
        current.field === 'maxConcurrentWorkers'
          ? { maxConcurrentWorkers: n }
          : { leaderTimeoutMs: n };
      committingRef.current = true;
      try {
        const ok = await applyPatch(patch);
        if (ok) setEdit({ kind: 'idle' });
      } finally {
        committingRef.current = false;
      }
      return;
    }

    if (current.kind === 'editing-text') {
      const trimmed = current.value.trim();
      // Empty input → clear the optional field.
      if (trimmed.length === 0) {
        committingRef.current = true;
        try {
          await applyPatch({ defaultProjectPath: null });
          setEdit({ kind: 'idle' });
        } finally {
          committingRef.current = false;
        }
        return;
      }
      // Validate the path exists AND looks like a git repo (project root
      // OR worktree). `<root>/.git` may be a directory (normal repo) or
      // a file (worktree); both are valid.
      if (!fs.existsSync(trimmed)) {
        showToast(`Path does not exist: ${trimmed}`, { tone: 'error' });
        return;
      }
      const gitMarker = path.join(trimmed, '.git');
      if (!fs.existsSync(gitMarker)) {
        showToast(`Not a git repo (no .git): ${trimmed}`, { tone: 'error' });
        return;
      }
      committingRef.current = true;
      try {
        const ok = await applyPatch({ defaultProjectPath: trimmed });
        if (ok) setEdit({ kind: 'idle' });
      } finally {
        committingRef.current = false;
      }
      return;
    }
  }, [applyPatch, showToast]);

  const cancelEdit = useCallback((): void => {
    // Audit M2: don't fire cancel while a commit is in flight — the
    // disk write may have already landed and the user's "cancel"
    // intent can't roll it back. The in-flight commit will close the
    // editor on success or leave it open on failure for the user to
    // re-attempt.
    if (committingRef.current) return;
    setEdit({ kind: 'idle' });
  }, []);

  // Handle Enter on a row in idle mode. Dispatch by edit kind.
  const handleEnter = useCallback((): void => {
    const row = rowsRef.current[selectedIdxRef.current];
    if (row === undefined || row.kind !== 'value') return;
    switch (row.editKind) {
      case 'bool':
        toggleBool(row.label);
        return;
      case 'enum':
        cycleEnum(row.label);
        return;
      case 'int':
        startIntEdit(
          selectedIdxRef.current,
          row.label,
          row.label === 'maxConcurrentWorkers'
            ? config.maxConcurrentWorkers
            : config.leaderTimeoutMs,
        );
        return;
      case 'text-path':
        startTextEdit(selectedIdxRef.current, row.label, config.defaultProjectPath ?? '');
        return;
      case 'readonly':
        if (row.label === 'keybindOverrides') {
          showToast('Keybind override editor ships in 3H.4.', { tone: 'info' });
        } else {
          showToast(`${row.label} is intrinsic and not editable.`, { tone: 'info' });
        }
        return;
    }
  }, [toggleBool, cycleEnum, startIntEdit, startTextEdit, showToast, config]);

  // Handle Space on a bool row (consistent shortcut).
  const handleSpace = useCallback((): void => {
    const row = rowsRef.current[selectedIdxRef.current];
    if (row === undefined || row.kind !== 'value') return;
    if (row.editKind === 'bool') {
      toggleBool(row.label);
    }
  }, [toggleBool]);

  const popupCommands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'settings.dismiss',
        title: 'close',
        key: { kind: 'escape' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          // Esc in idle → close popup; in edit mode → cancel edit.
          if (editRef.current.kind === 'idle') {
            popPopup();
          } else {
            cancelEdit();
          }
        },
      },
      {
        id: 'settings.next',
        title: 'next',
        key: { kind: 'downArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          if (editRef.current.kind === 'idle') move(1);
        },
      },
      {
        id: 'settings.prev',
        title: 'prev',
        key: { kind: 'upArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          if (editRef.current.kind === 'idle') move(-1);
        },
      },
      {
        id: 'settings.invoke',
        title: 'edit',
        key: { kind: 'return' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          // Audit M1: drop Enter while a commit is mid-await — prevents
          // double-fire of the same commit and stale-state second-commits.
          if (committingRef.current) return;
          if (editRef.current.kind === 'idle') handleEnter();
          else void commitEdit();
        },
      },
      {
        id: 'settings.toggle',
        title: 'toggle',
        key: { kind: 'char', char: ' ' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          if (editRef.current.kind === 'idle') handleSpace();
        },
      },
    ],
    [popPopup, cancelEdit, move, handleEnter, commitEdit, handleSpace],
  );

  useRegisterCommands(popupCommands, isFocused);

  // Edit-mode raw input handler — captures char input, backspace, etc.
  // Runs in PARALLEL with the keybind dispatcher (the dispatcher's
  // commands at scope 'settings' handle Enter / Esc / Space; this hook
  // handles char accumulation).
  //
  // Audit C1: negative whitelist mirrors InputBar/Palette pattern
  // (3F.1 audit M4) — `key.home`/`key.end` MUST be rejected so terminals
  // that decode those into key flags don't leak escape garbage as a
  // typed char. Same for pageUp/pageDown/tab.
  //
  // Audit M1: drops keystrokes while a commit is in flight. Prevents the
  // post-commit `setEdit({kind:'idle'})` from silently discarding chars
  // the user typed during the await window.
  //
  // Audit M4: Ctrl+U is the only emacs-style chord wired today (kill-
  // line). Backspace handles single-char delete. Full InputBar parity
  // (Ctrl+W kill-word, Ctrl+A/E line-start/end, Ctrl+K kill-to-end) is
  // a follow-up — the settings popup's typical typed buffer is short
  // enough that single-char delete + kill-line covers the common case.
  useInput(
    (input, key) => {
      if (committingRef.current) return;
      const current = editRef.current;
      if (current.kind === 'idle') return;
      // Ctrl+U → kill line (clear buffer).
      if (key.ctrl && input === 'u') {
        setEdit((prev) => {
          if (prev.kind === 'idle') return prev;
          return { ...prev, value: '' };
        });
        return;
      }
      // Backspace deletes from the buffer.
      if (key.backspace || key.delete) {
        setEdit((prev) => {
          if (prev.kind === 'idle') return prev;
          return { ...prev, value: prev.value.slice(0, -1) };
        });
        return;
      }
      // Skip control chars + Enter/Esc/arrows/home/end (the dispatcher
      // owns them, OR the terminal's escape-decoded modifier keys
      // shouldn't land in the typed buffer).
      if (
        key.return ||
        key.escape ||
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        key.tab ||
        key.pageUp ||
        key.pageDown ||
        key.home ||
        key.end ||
        key.ctrl ||
        key.meta
      ) {
        return;
      }
      // Accept printable input. For int fields, restrict to digits.
      if (input.length === 0) return;
      const filtered =
        current.kind === 'editing-int' ? input.replace(/[^0-9]/g, '') : input;
      if (filtered.length === 0) return;
      setEdit((prev) => {
        if (prev.kind === 'idle') return prev;
        return { ...prev, value: prev.value + filtered };
      });
    },
    { isActive: isFocused && edit.kind !== 'idle' },
  );

  const sourceLine = useMemo(() => formatSourceLine(source), [source]);
  const visible = useMemo(() => sliceVisible(rows, selectedIdx), [rows, selectedIdx]);

  const footerHint = useMemo(() => {
    if (edit.kind !== 'idle') return 'Enter commit · Esc cancel · Backspace delete';
    return '↑↓ navigate · Space toggle · Enter edit · Esc close';
  }, [edit.kind]);

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
          · Phase 3H.2
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.rows.length === 0 ? (
          <Text color={theme['textMuted']}>(no settings)</Text>
        ) : (
          visible.rows.map((row, offset) => {
            const absoluteIdx = visible.start + offset;
            const isSelected = absoluteIdx === selectedIdx;
            const isEditing =
              isSelected && edit.kind !== 'idle' && edit.rowIdx === absoluteIdx;
            return (
              <SettingsRow
                key={`${row.kind}-${absoluteIdx}`}
                row={row}
                selected={isSelected}
                editing={isEditing}
                editValue={isEditing ? edit.value : ''}
                theme={theme}
              />
            );
          })
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme['textMuted']}>{sourceLine}</Text>
        <Text color={theme['textMuted']}>{footerHint}</Text>
      </Box>
    </Box>
  );
}

interface SettingsRowProps {
  readonly row: Row;
  readonly selected: boolean;
  readonly editing: boolean;
  readonly editValue: string;
  readonly theme: Record<string, string>;
}

function SettingsRow({ row, selected, editing, editValue, theme }: SettingsRowProps): React.JSX.Element {
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
        <Text color={selected ? theme['accent'] : theme['textMuted']}>{marker}</Text>
        <Text color={theme['text']}>{row.label}</Text>
        <Box flexGrow={1} />
        {editing ? (
          <>
            <Text color={theme['accent']}>{editValue}</Text>
            {/* Inverse-cursor block — matches StatusLine's typed-input glyph */}
            <Text color={theme['accent']} inverse>
              {' '}
            </Text>
          </>
        ) : (
          <>
            <Text color={valueColor}>{row.value}</Text>
            <Text color={theme['textMuted']}>{` ${sourceTag}`}</Text>
          </>
        )}
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
  const fromFileSource: 'default' | 'file' = source.kind === 'file' ? 'file' : 'default';

  return [
    { kind: 'header', label: 'Model' },
    {
      kind: 'value',
      label: 'modelMode',
      value: config.modelMode,
      source: fromFileSource,
      editKind: 'enum',
      description: 'opus = all workers run Opus · mixed = orchestrator picks per task',
    },
    { kind: 'header', label: 'Workers' },
    {
      kind: 'value',
      label: 'maxConcurrentWorkers',
      value: String(config.maxConcurrentWorkers),
      source: fromFileSource,
      editKind: 'int',
      description: 'Cap enforced in Commit 4 of 3H.2 (queue gate). Range 1–32.',
    },
    { kind: 'header', label: 'Appearance' },
    {
      kind: 'value',
      label: 'theme.name',
      value: config.theme.name,
      source: fromFileSource,
      editKind: 'readonly',
      description: 'Locked palette (violet + gold). Multi-theme picker is a future phase.',
    },
    {
      kind: 'value',
      label: 'theme.autoFallback16Color',
      value: String(config.theme.autoFallback16Color),
      source: fromFileSource,
      editKind: 'bool',
      description: 'Probe terminal capability and fall back to 16-color on truecolor-less terminals',
    },
    { kind: 'header', label: 'Notifications' },
    {
      kind: 'value',
      label: 'notifications.enabled',
      value: String(config.notifications.enabled),
      source: fromFileSource,
      editKind: 'bool',
      description: 'Desktop toast on worker completed/failed/needs-input. Dispatcher ships in 3H.3.',
    },
    { kind: 'header', label: 'Project' },
    {
      kind: 'value',
      label: 'defaultProjectPath',
      value: config.defaultProjectPath ?? '(none)',
      source: fromFileSource,
      editKind: 'text-path',
      description: 'Pre-selected project at `symphony start` when no --project arg is passed',
    },
    { kind: 'header', label: 'Advanced' },
    {
      kind: 'value',
      label: 'leaderTimeoutMs',
      value: String(config.leaderTimeoutMs),
      source: fromFileSource,
      editKind: 'int',
      description: 'Window after Ctrl+X for the second key of a leader chord (100–1000)',
    },
    {
      kind: 'value',
      label: 'schemaVersion',
      value: String(config.schemaVersion),
      source: fromFileSource,
      editKind: 'readonly',
      description: 'Internal config-schema version. Future migrations branch on this.',
    },
    {
      kind: 'value',
      label: 'keybindOverrides',
      value: `${Object.keys(config.keybindOverrides).length} entries`,
      source: fromFileSource,
      editKind: 'readonly',
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
