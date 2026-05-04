import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/context.js';
import type { ProjectSnapshot } from '../../projects/types.js';
import type { WorkerRecordSnapshot } from '../../orchestrator/worker-registry.js';
import type { ToolMode } from '../../orchestrator/types.js';

/**
 * Top status bar: `Symphony v0.1.0 │ Mode: PLAN │ Workers: 0 │ Project: <name>`.
 *
 * Phase 3A renders from props (parent reads from data hooks) so the
 * component is trivially testable. Active workers = those whose status
 * is not in the terminal set.
 */

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'failed',
  'killed',
  'timeout',
  'crashed',
]);

export interface StatusBarProps {
  readonly version: string;
  readonly mode: ToolMode | null;
  readonly projects: readonly ProjectSnapshot[];
  readonly workers: readonly WorkerRecordSnapshot[];
  readonly sessionId: string | null;
  /** Phase 3E — total unanswered question count. */
  readonly questionsCount?: number;
  /** Phase 3E — count of unanswered BLOCKING questions (subset of total). */
  readonly blockingCount?: number;
}

function activeCount(workers: readonly WorkerRecordSnapshot[]): number {
  let n = 0;
  for (const w of workers) {
    if (!TERMINAL_STATUSES.has(w.status)) n++;
  }
  return n;
}

function formatMode(mode: ToolMode | null): string {
  if (mode === null) return '—';
  return mode.toUpperCase();
}

function formatProject(projects: readonly ProjectSnapshot[]): string {
  if (projects.length === 0) return '(none)';
  if (projects.length === 1) return projects[0]!.name;
  return `${projects[0]!.name} (+${projects.length - 1})`;
}

const SEPARATOR = ' │ ';

/**
 * Phase 3E — color rule for the `Q:` cell:
 *  - 0 unanswered → `textMuted` (no signal — same weight as the labels).
 *  - any blocking → `error` (red — must answer to unblock Maestro).
 *  - only advisory → `warning` (gold-light — nice-to-know, batchable).
 */
function questionsColor(
  theme: Record<string, string>,
  count: number,
  blockingCount: number,
): string {
  if (count === 0) return theme['textMuted']!;
  if (blockingCount > 0) return theme['error']!;
  return theme['warning']!;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const theme = useTheme();
  const active = activeCount(props.workers);
  const questionsCount = props.questionsCount ?? 0;
  const blockingCount = props.blockingCount ?? 0;
  return (
    <Box flexDirection="row" paddingX={1}>
      <Text color={theme['accent']} bold>
        Symphony
      </Text>
      <Text color={theme['textMuted']}> v{props.version}</Text>
      <Text color={theme['border']}>{SEPARATOR}</Text>
      <Text color={theme['textMuted']}>Mode: </Text>
      <Text color={theme['text']}>{formatMode(props.mode)}</Text>
      <Text color={theme['border']}>{SEPARATOR}</Text>
      <Text color={theme['textMuted']}>Workers: </Text>
      <Text color={active > 0 ? theme['accent'] : theme['text']}>{String(active)}</Text>
      <Text color={theme['border']}>{SEPARATOR}</Text>
      <Text color={theme['textMuted']}>Q: </Text>
      <Text color={questionsColor(theme, questionsCount, blockingCount)}>
        {String(questionsCount)}
      </Text>
      <Text color={theme['border']}>{SEPARATOR}</Text>
      <Text color={theme['textMuted']}>Project: </Text>
      <Text color={theme['text']}>{formatProject(props.projects)}</Text>
      {props.sessionId !== null && (
        <>
          <Text color={theme['border']}>{SEPARATOR}</Text>
          <Text color={theme['textMuted']}>Session: </Text>
          <Text color={theme['text']}>{props.sessionId.slice(0, 8)}</Text>
        </>
      )}
    </Box>
  );
}
