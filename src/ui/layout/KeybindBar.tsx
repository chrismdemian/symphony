import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/context.js';
import { useKeybinds } from '../keybinds/dispatcher.js';
import { formatBindings } from '../keybinds/registry.js';
import { useStdoutDimensions } from './useDimensions.js';

/**
 * Bottom context-sensitive keybind bar.
 *
 * Reads the deduped, scope-filtered command list from `useKeybinds()` and
 * renders each as `Key: Title  Key: Title …` with ellipsis truncation when
 * the line overflows. Pattern from lazygit `pkg/gui/options_map.go:36-103`.
 */

export function KeybindBar(): React.JSX.Element {
  const theme = useTheme();
  const { bar } = useKeybinds();
  const { columns } = useStdoutDimensions();
  // Account for 2-cell paddingX on the row.
  const usable = Math.max(10, columns - 2);
  const text = formatBindings(bar, usable);
  return (
    <Box flexDirection="row" paddingX={1}>
      <Text color={theme['textMuted']}>{text}</Text>
    </Box>
  );
}
