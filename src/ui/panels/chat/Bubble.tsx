import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import type { Block, Turn } from '../../data/chatHistoryReducer.js';

/**
 * One conversation turn — user message OR assistant turn (which can
 * contain interleaved text / tool / thinking blocks).
 *
 * Identity-comparator memo: the chat-history reducer preserves prior
 * turn refs across updates, so only the LAST turn's bubble rerenders
 * during streaming. Without this, every assistant_text chunk would
 * rerender all prior bubbles. Plan-agent A2 / Phase 3B Known Gotcha.
 *
 * 3B.1 ships minimal block styling: text plain, tool/thinking as
 * one-line stubs. Phase 3B.2 expands tool blocks via ToolCallSummary
 * (file_path / command / etc. extracted) and thinking via
 * ThinkingBubble (`⚡ Thinking:` dim italic prefix).
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
      {turn.blocks.map((block, idx) => (
        // Audit M6: 3B.1 keys by index because the chat reducer is
        // append-only at the block level (tool_result mutates in place
        // by slice-replace, preserving index identity). 3B.2's
        // `ToolCallSummary` will add per-block `useState` for
        // expand/collapse — at that point, switch to content-derived
        // keys (tool blocks already carry `callId`; text/thinking
        // blocks need a synthetic `blockId` assigned by the reducer).
        <BlockView key={idx} block={block} />
      ))}
      {turn.complete && turn.blocks.length === 0 ? (
        <Text color={theme['textMuted']} dimColor>
          (no output)
        </Text>
      ) : null}
    </Box>
  );
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
            {line}
          </Text>
        ))}
      </Box>
    );
  }
  if (block.kind === 'error') {
    // Visual review: the error block is the ONLY thing that goes red.
    // Prior streamed text in the same turn keeps the default color so
    // hierarchy ("what the model said" vs "what failed") survives.
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
    // 3B.1 stub — 3B.2 ships ThinkingBubble with full styling.
    return (
      <Text color={theme['textMuted']} dimColor italic>
        {`⚡ Thinking: ${truncate(block.text, 80)}`}
      </Text>
    );
  }
  // tool block — 3B.1 stub — 3B.2 ships ToolCallSummary.
  const status =
    block.result === null
      ? '…'
      : block.result.isError
        ? '✗'
        : '✓';
  const color =
    block.result === null
      ? theme['textMuted']
      : block.result.isError
        ? theme['error']
        : theme['success'];
  return (
    <Text color={color}>
      {`▸ ${block.name} ${status}`}
    </Text>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}
