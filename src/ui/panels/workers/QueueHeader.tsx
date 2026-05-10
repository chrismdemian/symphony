import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';

export interface QueueHeaderProps {
  readonly count: number;
  readonly collapsed: boolean;
  readonly selected: boolean;
}

/**
 * Phase 3L — header row for the task queue section. Sits below the
 * worker rows; visible only when `count > 0`. Uses the violet accent
 * color so it's visually distinct from the gold ProjectGroupHeader.
 *
 * Layout: `▌ ▾ Queue (N pending)`
 *   ▌ gutter (selected only) in accent
 *   ▾/▸ collapse glyph in accent
 *   Queue (N pending) in accent (bold when selected, inverse-bolded
 *   like other selectable rows when this row is the cursor target)
 */
export function QueueHeader({ count, collapsed, selected }: QueueHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const arrow = collapsed ? '▸' : '▾';
  const label = count === 1 ? '1 pending' : `${count} pending`;
  return (
    <Box flexDirection="row">
      {selected ? <Text color={theme['accent']}>▌</Text> : <Text> </Text>}
      <Text color={theme['accent']}> {arrow} </Text>
      {selected ? (
        <Text color={theme['accent']} bold inverse>
          Queue
        </Text>
      ) : (
        <Text color={theme['accent']} bold>
          Queue
        </Text>
      )}
      <Text color={theme['textMuted']}>{`  (${label})`}</Text>
    </Box>
  );
}
