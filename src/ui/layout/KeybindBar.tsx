import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/context.js';
import { useKeybinds } from '../keybinds/dispatcher.js';
import {
  formatBindings,
  formatKey,
  simpleChordEquals,
  type Command,
  type SimpleChord,
} from '../keybinds/registry.js';
import { useStdoutDimensions } from './useDimensions.js';

/**
 * Bottom context-sensitive keybind bar.
 *
 * Reads the deduped, scope-filtered command list from `useKeybinds()` and
 * renders each as `Key: Title  Key: Title …` with ellipsis truncation when
 * the line overflows. Pattern from lazygit `pkg/gui/options_map.go:36-103`.
 *
 * Phase 3F.2 — when a leader chord is armed, the bar shows a violet
 * `<lead> _` prefix AND lists the available leader-seconds (e.g.
 * `m: switch model · p: switch project · t: toggle theme`) so the user
 * doesn't have to remember the chord set (vim's WhichKey pattern,
 * audit M1). When idle, the bar shows the regular bindings.
 */

export function KeybindBar(): React.JSX.Element {
  const theme = useTheme();
  const { commands, bar, leaderActive } = useKeybinds();
  const { columns } = useStdoutDimensions();

  if (leaderActive !== null) {
    const seconds = listLeaderSeconds(commands, leaderActive);
    return (
      <Box flexDirection="row" paddingX={1}>
        <Text color={theme['accent']} bold>
          {formatKey(leaderActive)}
        </Text>
        <Text color={theme['textMuted']}> _ </Text>
        {seconds.length === 0 ? (
          <Text color={theme['textMuted']}>(no chords registered)</Text>
        ) : (
          <Text color={theme['textMuted']}>{formatLeaderSeconds(seconds)}</Text>
        )}
      </Box>
    );
  }

  // Account for 2-cell paddingX on the row.
  const usable = Math.max(10, columns - 2);
  const text = formatBindings(bar, usable);
  return (
    <Box flexDirection="row" paddingX={1}>
      <Text color={theme['textMuted']}>{text}</Text>
    </Box>
  );
}

interface LeaderSecond {
  readonly second: SimpleChord;
  readonly title: string;
}

function listLeaderSeconds(
  commands: readonly Command[],
  lead: SimpleChord,
): readonly LeaderSecond[] {
  const out: LeaderSecond[] = [];
  for (const cmd of commands) {
    if (cmd.key.kind !== 'leader') continue;
    if (cmd.disabledReason !== undefined) continue;
    if (!simpleChordEquals(cmd.key.lead, lead)) continue;
    out.push({ second: cmd.key.second, title: cmd.title });
  }
  return out;
}

function formatLeaderSeconds(seconds: readonly LeaderSecond[]): string {
  return seconds.map((s) => `${formatKey(s.second)}: ${s.title}`).join('  ·  ');
}
