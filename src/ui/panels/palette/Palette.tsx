import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
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
import { fuzzyFilter, type PaletteMatch } from './fuzzy.js';

/**
 * Phase 3F.1 — command palette popup.
 *
 * Mounted by `<Layout>` when the focus stack has a popup with key
 * `'palette'` on top. Lists every registered command across every
 * scope, fuzzy-filtered live by a typed query.
 *
 * Keybinds (popup scope `'palette'`):
 *   - Esc            → close popup (focus.popPopup)
 *   - Enter          → invoke selected command, then close popup
 *   - ↑ / ↓          → move selection
 *   - <printable>    → append to filter (handled via local useInput)
 *   - Backspace      → trim filter
 *
 * Char-keys are appended via a LOCAL `useInput` listener; Enter/Esc/
 * arrows are dispatched through the registered commands so the bottom
 * keybind bar can advertise them. The local handler skips meta keys
 * (return/escape/arrows/ctrl/meta) so it doesn't double-fire.
 *
 * Disabled commands (`disabledReason` set) render dimmed and are
 * silently skipped during selection nav. Selecting a disabled command
 * via Enter is a no-op (still closes palette per UX expectation).
 *
 * The palette deliberately does NOT call `selectCommands` — it wants
 * the FULL registry across every scope so the user can invoke any
 * action without first navigating to the panel that owns it. Use
 * `selectAllCommands` (registry.ts) instead.
 */

const SCOPE = 'palette';
const VISIBLE_ROWS = 12;

export function Palette(): React.JSX.Element {
  const theme = useTheme();
  const focus = useFocus();
  const { commands } = useKeybinds();
  const isFocused = focus.currentScope === SCOPE;
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);

  // Show every registered command — palette is the ONE surface that
  // sees across scope boundaries — EXCEPT commands flagged `internal`.
  // Phase 3F.1 audit C1: an earlier scope-allow-list approach was
  // brittle because every new popup scope (3F.2 leader-toast, 3F.3
  // history) had to remember to NOT appear here. The discriminator
  // on `Command` makes the contract explicit and exhaustive: popup-
  // internal nav (palette.invoke et al.) sets `internal: true`,
  // user-actionable commands at any scope leave it off.
  const allCommands = useMemo(
    () => selectAllCommands(commands).filter((c) => c.internal !== true),
    [commands],
  );
  const matches = useMemo(
    () => fuzzyFilter(allCommands, filter),
    [allCommands, filter],
  );

  // Clamp selection when filter changes — top match becomes default.
  const clampedIdx = matches.length === 0
    ? 0
    : Math.min(selectedIdx, matches.length - 1);

  // Refs mirror live state so popupCommands' onSelect closures can read
  // current matches + selection WITHOUT pulling those values into useMemo
  // deps. Without this, registering palette commands flips the registry's
  // identity → matches re-derives → popupCommands re-memos → cleanup +
  // re-register → loop. Static popupCommands identity breaks the cycle.
  // (Mirrors the audit-m7 ref pattern used by QuestionPopup for focus.)
  const matchesRef = useRef(matches);
  const clampedIdxRef = useRef(clampedIdx);
  useEffect(() => {
    matchesRef.current = matches;
  }, [matches]);
  useEffect(() => {
    clampedIdxRef.current = clampedIdx;
  }, [clampedIdx]);

  const popPopup = focus.popPopup;
  const invoke = useCallback(
    (cmd: Command): void => {
      // Pop the palette FIRST always — even on disabled commands. An
      // earlier version returned BEFORE pop on disabled, leaving the
      // palette mounted with no signal that the keystroke landed
      // (Phase 3F.1 audit M1: silent-no-op black hole UX). After pop,
      // skip the action when disabled so the closure doesn't fire its
      // onSelect against stale state.
      //
      // Pop before onSelect also handles the chained-popup case:
      // `worker.select` → `pushPopup('worker-select')` lands on top of
      // a now-empty popup stack, not on top of the palette.
      popPopup();
      if (cmd.disabledReason !== undefined) return;
      const result = cmd.onSelect();
      if (result instanceof Promise) {
        result.catch((err) => {
          process.stderr.write(
            `[palette] command "${cmd.id}" failed: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        });
      }
    },
    [popPopup],
  );

  const move = useCallback((delta: 1 | -1): void => {
    const list = matchesRef.current;
    if (list.length <= 1) return;
    setSelectedIdx((idx) => {
      const start = Math.min(idx, list.length - 1);
      let next = start;
      for (let step = 0; step < list.length; step++) {
        next = (next + delta + list.length) % list.length;
        if (list[next]?.cmd.disabledReason === undefined) return next;
      }
      return start;
    });
  }, []);

  const popupCommands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'palette.dismiss',
        title: 'close',
        key: { kind: 'escape' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => popPopup(),
      },
      {
        id: 'palette.invoke',
        title: 'invoke',
        key: { kind: 'return' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          const list = matchesRef.current;
          const idx = clampedIdxRef.current;
          const m = list[idx];
          if (m === undefined) return;
          invoke(m.cmd);
        },
      },
      {
        id: 'palette.next',
        title: 'next',
        key: { kind: 'downArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => move(1),
      },
      {
        id: 'palette.prev',
        title: 'prev',
        key: { kind: 'upArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => move(-1),
      },
    ],
    [popPopup, invoke, move],
  );

  useRegisterCommands(popupCommands, isFocused);

  // Local input listener for printable chars + backspace. Skips meta
  // keys so it doesn't double-fire alongside the registered commands.
  // Audit M4 (Phase 3F.1): mirror InputBar's full negative whitelist
  // (`InputBar.tsx:167-184`) — terminals that don't decode pageUp/Down/
  // Home/End into `key.*` flags emit raw `[5~`/`[6~` escape garbage. We
  // rely on Ink's parser to surface those as `key.*` flags and reject
  // them here. Genuine multi-char input (paste / quick typing batched
  // by the terminal) is allowed to land.
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
          Command palette
        </Text>
        <Text color={theme['textMuted']}>
          {' '}
          · {matches.length} of {allCommands.length}
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
        {matches.length === 0 ? (
          <Text color={theme['textMuted']}>(no commands match)</Text>
        ) : (
          renderRows(matches, clampedIdx, theme)
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme['textMuted']}>
          ↑↓ to navigate · Enter to invoke · Esc to close
        </Text>
      </Box>
    </Box>
  );
}

function renderRows(
  matches: readonly PaletteMatch[],
  selectedIdx: number,
  theme: Record<string, string>,
): React.JSX.Element[] {
  const window = computeWindow(matches.length, selectedIdx, VISIBLE_ROWS);
  const rows: React.JSX.Element[] = [];
  for (let i = window.start; i < window.end; i++) {
    const m = matches[i];
    if (m === undefined) continue;
    rows.push(<PaletteRow key={m.cmd.id} match={m} selected={i === selectedIdx} theme={theme} />);
  }
  return rows;
}

function computeWindow(
  total: number,
  selected: number,
  size: number,
): { readonly start: number; readonly end: number } {
  if (total <= size) return { start: 0, end: total };
  let start = Math.max(0, selected - Math.floor(size / 2));
  const end = Math.min(total, start + size);
  start = Math.max(0, end - size);
  return { start, end };
}

interface PaletteRowProps {
  readonly match: PaletteMatch;
  readonly selected: boolean;
  readonly theme: Record<string, string>;
}

function PaletteRow({ match, selected, theme }: PaletteRowProps): React.JSX.Element {
  const { cmd, indexes } = match;
  const disabled = cmd.disabledReason !== undefined;
  const titleColor = disabled ? theme['textMuted']! : theme['text']!;
  const keyText = formatKey(cmd.key);
  const marker = selected ? '▸ ' : '  ';
  return (
    <Box flexDirection="row">
      <Text color={selected ? theme['accent'] : theme['textMuted']}>{marker}</Text>
      <Box flexDirection="row" flexGrow={1}>
        <HighlightedTitle
          title={cmd.title}
          indexes={indexes}
          baseColor={titleColor}
          accentColor={theme['accent']!}
          dim={disabled}
        />
        {disabled ? (
          <Text color={theme['textMuted']} dimColor>
            {' '}
            ({cmd.disabledReason})
          </Text>
        ) : null}
      </Box>
      <Text color={theme['textMuted']}>{keyText !== '' ? `  ${keyText}` : ''}</Text>
      <Text color={theme['textMuted']}>
        {'  '}
        {scopeBadge(cmd.scope)}
      </Text>
    </Box>
  );
}

interface HighlightedTitleProps {
  readonly title: string;
  readonly indexes: readonly number[];
  readonly baseColor: string;
  readonly accentColor: string;
  readonly dim: boolean;
}

function HighlightedTitle({
  title,
  indexes,
  baseColor,
  accentColor,
  dim,
}: HighlightedTitleProps): React.JSX.Element {
  if (indexes.length === 0) {
    return (
      <Text color={baseColor} dimColor={dim}>
        {title}
      </Text>
    );
  }
  const set = new Set(indexes);
  const chars: React.JSX.Element[] = [];
  for (let i = 0; i < title.length; i++) {
    const ch = title[i]!;
    if (set.has(i)) {
      chars.push(
        <Text key={i} color={accentColor} bold dimColor={dim}>
          {ch}
        </Text>,
      );
    } else {
      chars.push(
        <Text key={i} color={baseColor} dimColor={dim}>
          {ch}
        </Text>,
      );
    }
  }
  return <Text>{chars}</Text>;
}

function scopeBadge(scope: string): string {
  if (scope === 'global') return '';
  if (scope === 'main') return '';
  return `[${scope}]`;
}
