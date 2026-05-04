import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import { formatRuntime } from '../workers/WorkerRow.js';
import type { ProjectSnapshot } from '../../../projects/types.js';

/**
 * Phase 3E — single muted line: `Project: <name> · Worker: <id> · 2m ago`.
 *
 * Reuses `formatRuntime` (`src/ui/panels/workers/WorkerRow.tsx:99`) for
 * the relative-time render so popup ageing has the same shape as the
 * worker panel's runtime label. Falls back to `(no project)` /
 * `(no worker)` when the question wasn't scoped at enqueue time.
 *
 * Project name resolves from the already-loaded `useProjects(rpc)` list
 * (no per-popup RPC fetch); the parent passes `projects` down so this
 * component stays render-only.
 */
export interface QuestionMetaProps {
  readonly projectId?: string | undefined;
  readonly workerId?: string | undefined;
  readonly askedAt: string;
  readonly nowMs: number;
  readonly projects: readonly ProjectSnapshot[];
}

const SEPARATOR = ' · ';

function projectLabel(
  projectId: string | undefined,
  projects: readonly ProjectSnapshot[],
): string {
  if (projectId === undefined) return '(no project)';
  const found = projects.find((p) => p.id === projectId);
  if (found === undefined) return projectId;
  return found.name;
}

function workerLabel(workerId: string | undefined): string {
  if (workerId === undefined) return '(no worker)';
  return workerId;
}

export function QuestionMeta(props: QuestionMetaProps): React.JSX.Element {
  const theme = useTheme();
  const elapsed = formatRuntime(props.askedAt, props.nowMs);
  return (
    <Box flexDirection="row">
      <Text color={theme['textMuted']}>Project: </Text>
      <Text color={theme['text']}>{projectLabel(props.projectId, props.projects)}</Text>
      <Text color={theme['textMuted']}>{SEPARATOR}Worker: </Text>
      <Text color={theme['text']}>{workerLabel(props.workerId)}</Text>
      <Text color={theme['textMuted']}>
        {SEPARATOR}
        {elapsed} ago
      </Text>
    </Box>
  );
}
