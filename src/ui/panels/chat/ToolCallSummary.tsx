import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import type { Block } from '../../data/chatHistoryReducer.js';
import { extractToolSummary, formatToolResult } from './extractSummary.js';

/**
 * Renders a tool block as:
 *
 *   ▸ {name} {summary}                    (gold/red/muted depending on state)
 *     {ANSI-stripped result body, dim}     (only after tool_result lands)
 *
 * Status glyph maps:
 *   pending — `…` muted gray
 *   success — `✓` gold
 *   error   — `✗` red
 *
 * Phase 3F will add interactive expand/collapse; in 3B.2 the result
 * body always renders inline (truncated at 1500 chars). React.memo on
 * block reference keeps re-renders bounded as parent turns mutate.
 */

type ToolBlock = Extract<Block, { kind: 'tool' }>;

export interface ToolCallSummaryProps {
  readonly block: ToolBlock;
}

function ToolCallSummaryImpl({ block }: ToolCallSummaryProps): React.JSX.Element {
  const theme = useTheme();
  const summary = extractToolSummary(block.input);

  const status: 'pending' | 'success' | 'error' =
    block.result === null ? 'pending' : block.result.isError ? 'error' : 'success';

  const glyph = status === 'pending' ? '…' : status === 'error' ? '✗' : '✓';
  const headerColor =
    status === 'pending'
      ? theme['textMuted']
      : status === 'error'
        ? theme['error']
        : theme['success'];

  const header = summary.length === 0
    ? `▸ ${block.name} ${glyph}`
    : `▸ ${block.name} ${summary} ${glyph}`;

  const resultBody = block.result === null ? '' : formatToolResult(block.result.content);

  return (
    <Box flexDirection="column">
      <Text color={headerColor}>{header}</Text>
      {resultBody.length > 0
        ? resultBody.split('\n').map((line, i) => (
            <Text key={i} color={theme['textMuted']} dimColor>
              {`  ${line}`}
            </Text>
          ))
        : null}
    </Box>
  );
}

export const ToolCallSummary = memo(
  ToolCallSummaryImpl,
  (prev, next) => prev.block === next.block,
);
