import React from 'react';
import { Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import type { QuestionUrgency } from '../../../state/question-registry.js';

/**
 * Phase 3E — single-character-style urgency tag.
 *
 * Blocking: red `[BLOCKING]` (theme.error) — must answer to unblock work.
 * Advisory: gold-light `[advisory]` (theme.warning) — batchable.
 *
 * Inverse + bold reads as a "tag" / "pill" in every terminal regardless
 * of theme, while keeping the locked palette (no new tokens, no bg
 * color overrides — Ink's `inverse` flips fg/bg of the surrounding line,
 * which the terminal emulator paints with the foreground color).
 */
export interface UrgencyBadgeProps {
  readonly urgency: QuestionUrgency;
}

export function UrgencyBadge({ urgency }: UrgencyBadgeProps): React.JSX.Element {
  const theme = useTheme();
  if (urgency === 'blocking') {
    return (
      <Text color={theme['error']} bold>
        [BLOCKING]
      </Text>
    );
  }
  return (
    <Text color={theme['warning']} bold>
      [advisory]
    </Text>
  );
}
