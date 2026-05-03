import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import type { Block, Turn } from '../../data/chatHistoryReducer.js';
import { ToolCallSummary } from './ToolCallSummary.js';
import { ThinkingBubble } from './ThinkingBubble.js';

/**
 * One conversation turn — user message OR assistant turn (which can
 * contain interleaved text / tool / thinking / error blocks).
 *
 * Identity-comparator memo: the chat-history reducer preserves prior
 * turn refs across updates, so only the LAST turn's bubble rerenders
 * during streaming. Without this, every assistant_text chunk would
 * rerender all prior bubbles. Plan-agent A2 / Phase 3B Known Gotcha.
 *
 * 3B.2 keys block children by content-derived ids (text/thinking/error
 * carry `blockId`; tool blocks carry `callId`). Audit M6: index keys
 * are brittle once block components hold local state, which 3F's
 * expand/collapse will require — paying the cost now keeps the seam
 * clean.
 */

export interface BubbleProps {
  readonly turn: Turn;
}

function BubbleImpl({ turn }: BubbleProps): React.JSX.Element {
  const theme = useTheme();
  if (turn.kind === 'user') {
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color={theme['accent']} bold>
          {'❯ '}
        </Text>
        <Box flexDirection="column" flexGrow={1}>
          {turn.text.split('\n').map((line, i) => (
            <Text key={i} color={theme['text']}>
              {line}
            </Text>
          ))}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {turn.blocks.map((block) => (
        <BlockView key={blockKey(block)} block={block} />
      ))}
      {turn.complete && turn.blocks.length === 0 ? (
        <Text color={theme['textMuted']} dimColor>
          (no output)
        </Text>
      ) : null}
    </Box>
  );
}

function blockKey(block: Block): string {
  return block.kind === 'tool' ? block.callId : block.blockId;
}

export const Bubble = memo(BubbleImpl, (prev, next) => prev.turn === next.turn);

interface BlockViewProps {
  readonly block: Block;
}

function BlockView({ block }: BlockViewProps): React.JSX.Element {
  const theme = useTheme();
  if (block.kind === 'text') {
    return (
      <Box flexDirection="column">
        {block.text.split('\n').map((line, i) => (
          <Text key={i} color={theme['text']}>
            {line.length === 0 ? ' ' : line}
          </Text>
        ))}
      </Box>
    );
  }
  if (block.kind === 'error') {
    return (
      <Box flexDirection="column">
        {block.text.split('\n').map((line, i) => (
          <Text key={i} color={theme['error']}>
            {line}
          </Text>
        ))}
      </Box>
    );
  }
  if (block.kind === 'thinking') {
    return <ThinkingBubble block={block} />;
  }
  return <ToolCallSummary block={block} />;
}
