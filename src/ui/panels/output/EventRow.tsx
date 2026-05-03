import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import { extractToolSummary, formatToolResult } from '../chat/extractSummary.js';
import type { DisplayedStreamEvent } from '../../data/workerEventsReducer.js';

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
      return <Text color={theme['outputText']}>{event.text}</Text>;
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

export const EventRow = React.memo(EventRowImpl);
