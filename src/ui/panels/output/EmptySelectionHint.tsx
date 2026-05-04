import React from 'react';
import { Text } from 'ink';
import { useTheme } from '../../theme/context.js';

/**
 * Phase 3D.1 — empty-state hint when no worker is selected.
 *
 * Mirrors the chat panel's "Tell Maestro what to do…" placeholder:
 * single muted line, no border, no animation. Suggests the keyboard
 * actions the user already has in the workers panel so they don't have
 * to discover them.
 */
export function EmptySelectionHint(): React.JSX.Element {
  const theme = useTheme();
  // Visual review m1: drop the `dimColor` — `textMuted` (#888888) is
  // already a muted shade. Stacking dim on top renders nearly invisible
  // in low-contrast terminal themes.
  return (
    <Text color={theme['textMuted']}>
      Select a worker — j/k or 1-9 in the workers panel.
    </Text>
  );
}
