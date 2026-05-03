import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import type { Block } from '../../data/chatHistoryReducer.js';

/**
 * Renders an `assistant_thinking` block.
 *
 * No glyph (project no-emoji rule). Lead with a dim italic `thinking`
 * label, then the body line-by-line in muted gray italic so it visually
 * recedes behind real assistant text. Hierarchy: a thinking block does
 * not interrupt the reading flow of streamed answers.
 */

type ThinkingBlock = Extract<Block, { kind: 'thinking' }>;

export interface ThinkingBubbleProps {
  readonly block: ThinkingBlock;
}

function ThinkingBubbleImpl({ block }: ThinkingBubbleProps): React.JSX.Element {
  const theme = useTheme();
  const lines = block.text.split('\n');
  return (
    <Box flexDirection="column">
      <Text color={theme['textMuted']} dimColor italic>
        thinking
      </Text>
      {lines.map((line, i) => (
        <Text key={i} color={theme['textMuted']} dimColor italic>
          {line.length === 0 ? ' ' : line}
        </Text>
      ))}
    </Box>
  );
}

export const ThinkingBubble = memo(
  ThinkingBubbleImpl,
  (prev, next) => prev.block === next.block,
);
