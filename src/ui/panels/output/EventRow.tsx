import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import { extractToolSummary, formatToolResult } from '../chat/extractSummary.js';
import type { DisplayedStreamEvent } from '../../data/workerEventsReducer.js';
import { detectJsonRenderBlocks } from './jsonRenderDetect.js';
import { detectMarkdownFences, type CodeSegment } from './markdownFenceDetect.js';
import { JsonRenderBlock, FallbackPlainText } from './JsonRenderBlock.js';
import { CodeBlock } from './CodeBlock.js';

/** Visual review m2: split the trailing "… N more lines" elision marker
 * out of the tool_result body so it renders in muted gray (metadata)
 * rather than the body's success/error color (data). Convention from
 * Claude Code, lazygit, k9s. */
const ELISION_MARKER_RE = /^… \d+ more lines?$/;

/**
 * Phase 3D.1 — single-event renderer for the output panel.
 *
 * Discriminated-union switch over the visible StreamEvent set (silent
 * types are filtered at the reducer entry, so this component should
 * never see them in practice — defensive fallback returns null).
 *
 * Style invariants:
 *   - Tool-input summarization reuses `extractToolSummary` from 3B.2 so
 *     the chat tool bubbles and output-panel rows stay visually aligned.
 *   - Tool-result content is ANSI-stripped + capped at 1500 chars + 12
 *     lines via `formatToolResult` for the same reason.
 *   - Event identity is stable (events are appended, never mutated), so
 *     React.memo on identity equivalence is the cheapest correctness
 *     gate against re-renders during streaming.
 */

export interface EventRowProps {
  readonly event: DisplayedStreamEvent;
}

function EventRowImpl({ event }: EventRowProps): React.JSX.Element | null {
  const theme = useTheme();

  switch (event.type) {
    case 'assistant_text': {
      if (event.text.length === 0) return null;
      // Phase 3D.2 + 3F.4 segmentation pipeline:
      //   1. Detect ` ```json-render ` fences first (3D.2). They're
      //      reserved and own the highest-precedence render path.
      //   2. For each plain-text leftover, run `detectMarkdownFences`
      //      (3F.4) to split out generic code/diff blocks. The detector
      //      explicitly skips the `json-render` tag so step 1 stays
      //      authoritative for that.
      const { segments: jsonSegs } = detectJsonRenderBlocks(event.text);
      // Fast path: no fences anywhere → preserve the existing single-
      // Text render. React.memo identity stays stable for the common
      // case (most assistant_text has no fences at all).
      if (jsonSegs.length === 1 && jsonSegs[0]?.kind === 'text') {
        const inner = detectMarkdownFences(jsonSegs[0].value);
        if (inner.segments.length === 1 && inner.segments[0]?.kind === 'text') {
          return <Text color={theme['outputText']}>{inner.segments[0].value}</Text>;
        }
        return (
          <Box flexDirection="column">
            {inner.segments.map((seg, i) =>
              renderCodeSegment(seg, `code-${i}`, theme),
            )}
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          {jsonSegs.map((seg, i) => {
            const key = `seg-${i}`;
            if (seg.kind === 'text') {
              if (seg.value.length === 0) return null;
              const inner = detectMarkdownFences(seg.value);
              if (inner.segments.length === 1 && inner.segments[0]?.kind === 'text') {
                return (
                  <Text key={key} color={theme['outputText']}>
                    {inner.segments[0].value}
                  </Text>
                );
              }
              return (
                <Box key={key} flexDirection="column">
                  {inner.segments.map((cs, j) =>
                    renderCodeSegment(cs, `${key}-code-${j}`, theme),
                  )}
                </Box>
              );
            }
            if (seg.kind === 'invalid') {
              return (
                <FallbackPlainText
                  key={key}
                  reason={seg.reason}
                  raw={seg.raw}
                />
              );
            }
            return <JsonRenderBlock key={key} spec={seg.spec} />;
          })}
        </Box>
      );
    }

    case 'assistant_thinking': {
      if (event.text.length === 0) return null;
      return (
        <Text color={theme['textMuted']} italic>
          thinking  {event.text}
        </Text>
      );
    }

    case 'tool_use': {
      const summary = extractToolSummary(event.input);
      const text = summary.length === 0 ? `▸ ${event.name}` : `▸ ${event.name}  ${summary}`;
      return <Text color={theme['toolPending']}>{text}</Text>;
    }

    case 'tool_result': {
      const content = formatToolResult(event.content);
      if (content.length === 0) return null;
      const color = event.isError ? theme['toolError'] : theme['toolSuccess'];
      const lines = content.split('\n');
      const lastLine = lines[lines.length - 1] ?? '';
      const hasElision = ELISION_MARKER_RE.test(lastLine);
      if (!hasElision) {
        return <Text color={color}>{content}</Text>;
      }
      const body = lines.slice(0, -1).join('\n');
      return (
        <Box flexDirection="column">
          <Text color={color}>{body}</Text>
          <Text color={theme['textMuted']}>{lastLine}</Text>
        </Box>
      );
    }

    case 'result': {
      const seconds = Math.max(0, Math.round(event.durationMs / 1000));
      const turnLabel = event.numTurns === 1 ? 'turn' : 'turns';
      const head = event.isError ? '✗ failed' : '● completed';
      const color = event.isError ? theme['error'] : theme['success'];
      return (
        <Text color={color}>
          {head} — {event.numTurns} {turnLabel}, {seconds}s
        </Text>
      );
    }

    case 'parse_error': {
      const linePart = event.line === undefined ? '' : ` — ${event.line.slice(0, 200)}`;
      return (
        <Text color={theme['error']}>
          parse_error: {event.reason}{linePart}
        </Text>
      );
    }

    case 'system_api_retry': {
      const seconds =
        typeof event.delayMs === 'number'
          ? Math.max(0, Math.round(event.delayMs / 1000))
          : null;
      const attempt = typeof event.attempt === 'number' ? event.attempt : '?';
      const retryPart = seconds === null ? 'retrying' : `retry in ${seconds}s`;
      return (
        <Text color={theme['rateLimitWarning']}>
          ⏱ rate limited — attempt {attempt}, {retryPart}
        </Text>
      );
    }

    case 'structured_completion': {
      // Phase 3D.1 ships a one-line summary. Inline json-render of
      // `event.report.display` is Phase 3D.2's deliverable — it slots in
      // here cleanly via the same EventRow without any caller changes.
      return (
        <Text color={theme['success']}>
          completion — audit={event.report.audit}, did={event.report.did.length}
        </Text>
      );
    }
  }
}

function renderCodeSegment(
  seg: CodeSegment,
  key: string,
  theme: Record<string, string>,
): React.JSX.Element | null {
  if (seg.kind === 'text') {
    if (seg.value.length === 0) return null;
    return (
      <Text key={key} color={theme['outputText']}>
        {seg.value}
      </Text>
    );
  }
  if (seg.kind === 'diff') {
    return <CodeBlock key={key} kind="diff" source={seg.source} />;
  }
  return <CodeBlock key={key} kind="code" lang={seg.lang} source={seg.source} />;
}

export const EventRow = React.memo(EventRowImpl);
