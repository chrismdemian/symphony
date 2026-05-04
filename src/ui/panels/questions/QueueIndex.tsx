import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';

/**
 * Phase 3E — popup footer hint: navigation + position + keybind crib.
 *
 * Renders nothing for the position cell when total ≤ 1 (no queue
 * navigation possible) — keeps the footer tight in the common case.
 */
export interface QueueIndexProps {
  readonly index: number;
  readonly total: number;
}

const SEPARATOR = ' · ';
const HINTS = 'Esc dismiss · Enter submit · Ctrl+J newline';
const NAV_HINT = 'Tab/Shift+Tab cycle queue';

export function QueueIndex({ index, total }: QueueIndexProps): React.JSX.Element {
  const theme = useTheme();
  const showNav = total > 1;
  return (
    <Box flexDirection="row">
      {showNav ? (
        <>
          <Text color={theme['accent']}>
            {index + 1}/{total} queued
          </Text>
          <Text color={theme['textMuted']}>{SEPARATOR}</Text>
          <Text color={theme['textMuted']}>{NAV_HINT}</Text>
          <Text color={theme['textMuted']}>{SEPARATOR}</Text>
        </>
      ) : null}
      <Text color={theme['textMuted']}>{HINTS}</Text>
    </Box>
  );
}
