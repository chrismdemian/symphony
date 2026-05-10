import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';

export interface QueueRowProps {
  /** 1-based ordinal across the merged global queue. */
  readonly ordinal: number;
  readonly featureIntentDisplay: string;
  readonly projectDisplayName: string;
  readonly selected: boolean;
}

/**
 * Phase 3L — single row in the task queue panel.
 *
 * Layout (left → right):
 *   [gutter] [prefix] [feature-intent] [space-fill] [(project)]
 *
 * `prefix`:
 *   - "Next →" for ordinal === 1 in muted-gray
 *   - " 2.    " / " 3.    " etc. for the rest in muted-gray
 *
 * `featureIntentDisplay` is pre-truncated by the parent (matches
 * WorkerRow's contract — the row doesn't measure terminal width).
 * `projectDisplayName` is derived via `deriveDisplayName(projectPath)`.
 *
 * Inverse-highlight on selection wraps only the feature intent text,
 * never trailing padding (audit M1/M2 pattern from 3C).
 */
export function QueueRow({
  ordinal,
  featureIntentDisplay,
  projectDisplayName,
  selected,
}: QueueRowProps): React.JSX.Element {
  const theme = useTheme();
  const prefix = ordinal === 1 ? 'Next →' : `${formatOrdinal(ordinal)}.    `;
  return (
    <Box flexDirection="row">
      {selected ? <Text color={theme['accent']}>▌</Text> : <Text> </Text>}
      <Text color={theme['textMuted']}> {prefix} </Text>
      {selected ? (
        <Text color={theme['text']} inverse>
          {featureIntentDisplay}
        </Text>
      ) : (
        <Text color={theme['text']}>{featureIntentDisplay}</Text>
      )}
      <Box flexGrow={1} />
      <Text color={theme['textMuted']}>{` (${projectDisplayName})`}</Text>
    </Box>
  );
}

/**
 * Two-character right-aligned ordinal so `2.` and `10.` columns line up
 * cleanly. Single-digit ordinals (1-9) get a leading space; double-digit
 * ordinals (10-99) render unchanged. The "Next →" prefix bypasses this
 * formatter for ordinal === 1.
 */
function formatOrdinal(n: number): string {
  if (n < 10) return ` ${n}`;
  return String(n);
}
