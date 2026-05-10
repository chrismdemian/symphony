import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import type { Block, SystemTurn, Turn } from '../../data/chatHistoryReducer.js';
import type { CompletionStatusKind } from '../../../orchestrator/completion-summarizer-types.js';
import { ToolCallSummary } from './ToolCallSummary.js';
import { ThinkingBubble } from './ThinkingBubble.js';
import { formatDuration } from '../../../orchestrator/completion-summarizer-format.js';
import { useResolveWorkerName } from '../../data/InstrumentNameContext.js';

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

  if (turn.kind === 'system') {
    return <SystemBubble turn={turn} />;
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

/**
 * Phase 3K — completion summary row. Flat layout (no bordered bubble)
 * with a status icon + worker · project · duration header line, then
 * 1-3 indented body lines (headline / metrics / details). Visually
 * distinct from user (`❯`-prefixed) and assistant (multi-block) turns
 * so it reads as "system event in the timeline" rather than dialogue.
 */
interface SystemBubbleProps {
  readonly turn: SystemTurn;
}

interface StatusGlyph {
  readonly icon: string;
  readonly token: 'success' | 'error' | 'warning';
}

function statusGlyph(kind: CompletionStatusKind): StatusGlyph {
  switch (kind) {
    case 'completed':
      return { icon: '✓', token: 'success' };
    case 'failed':
    case 'crashed':
      return { icon: '✗', token: 'error' };
    case 'timeout':
      return { icon: '⏱', token: 'warning' };
  }
}

function SystemBubble({ turn }: SystemBubbleProps): React.JSX.Element {
  const theme = useTheme();
  const glyph = statusGlyph(turn.summary.statusKind);
  const headerColor = theme[glyph.token];
  // Audit C1: resolve the instrument name at render time rather than
  // at receipt. Workers that complete faster than one poll-tick window
  // aren't in the allocator at receipt; later polls surface them and
  // this lookup recovers the proper name. Falls back to the stored
  // fallback (server's slug or whatever pushSystem was called with).
  const resolveWorkerName = useResolveWorkerName();
  const resolvedName = resolveWorkerName(turn.summary.workerId);
  const workerName =
    resolvedName !== undefined && resolvedName.length > 0
      ? resolvedName
      : turn.summary.workerName;
  const durationLabel =
    turn.summary.durationMs !== null ? formatDuration(turn.summary.durationMs) : '(unknown)';
  const headline = turn.summary.headline;
  const metrics = turn.summary.metrics;
  const details = turn.summary.details;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={headerColor} bold>
          {glyph.icon}{' '}
        </Text>
        <Text color={headerColor} bold>
          {workerName}
        </Text>
        <Text color={theme['textMuted']}>
          {' ('}
          {turn.summary.projectName}
          {') · '}
          {durationLabel}
        </Text>
      </Box>
      {/*
        * Visual review (3K) flagged a wrap-indent regression: a row
        * Box with a 2-space `<Text>` leader + a content `<Text>`
        * dropped the leader on Ink's wrapped continuation lines (the
        * leader rendered once on row 1; rows 2+ started at col 0).
        * `paddingLeft={2}` applies to every wrapped sub-row, keeping
        * the indent stable across wrap boundaries.
        */}
      {headline.split('\n').map((line, i) => (
        <Box key={`h-${i}`} paddingLeft={2}>
          <Text color={theme['text']}>{line.length === 0 ? ' ' : line}</Text>
        </Box>
      ))}
      {metrics !== undefined
        ? metrics.split('\n').map((line, i) => (
            <Box key={`m-${i}`} paddingLeft={2}>
              <Text color={theme['textMuted']}>{line.length === 0 ? ' ' : line}</Text>
            </Box>
          ))
        : null}
      {details !== undefined
        ? details.split('\n').map((line, i) => (
            <Box key={`d-${i}`} paddingLeft={2}>
              <Text color={theme['textMuted']}>{line.length === 0 ? ' ' : line}</Text>
            </Box>
          ))
        : null}
    </Box>
  );
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
