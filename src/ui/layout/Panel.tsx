import React, { type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/context.js';
import { useFocus, type FocusKey } from '../focus/focus.js';

/**
 * Generic bordered slot. Border color flips violet → dim based on focus.
 *
 * Phase 3A renders these as empty placeholders; 3B/3C/3D fill the
 * `children` slot.
 */

export interface PanelProps {
  readonly focusKey: FocusKey;
  readonly title: string;
  readonly children: ReactNode;
  /** Optional `flexBasis` / `width` override. Default: `flexGrow={1}`. */
  readonly width?: string | number;
  readonly flexGrow?: number;
  readonly flexBasis?: string | number;
}

export function Panel({
  focusKey,
  title,
  children,
  width,
  flexGrow,
  flexBasis,
}: PanelProps): React.JSX.Element {
  const theme = useTheme();
  const focus = useFocus();
  const focused = focus.currentMainKey === focusKey;
  const borderColor = focused ? theme['borderActive'] : theme['border'];
  const titleColor = focused ? theme['accent'] : theme['textMuted'];

  const boxProps: Record<string, unknown> = {
    flexDirection: 'column',
    borderStyle: 'round',
    borderColor,
    paddingX: 1,
    paddingY: 0,
  };
  if (width !== undefined) boxProps['width'] = width;
  if (flexGrow !== undefined) boxProps['flexGrow'] = flexGrow;
  if (flexBasis !== undefined) boxProps['flexBasis'] = flexBasis;

  return (
    <Box {...boxProps}>
      <Box marginBottom={0}>
        <Text color={titleColor} bold>
          {title}
        </Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}
