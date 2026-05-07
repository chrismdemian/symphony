import React from 'react';
import { Box, Text } from 'ink';
import type { WorkerRole } from '../../../orchestrator/types.js';
import type { WorkerStatus } from '../../../workers/types.js';
import { useTheme } from '../../theme/context.js';
import { PIPELINE_STAGE_COUNT, roleToStage } from './stage.js';

/**
 * Phase 3I — 5-cell quality-pipeline progress bar for a single worker.
 *
 * Cell coloring:
 *   - cells before this worker's stage   → gold (workerDone)
 *   - cell at this worker's stage:
 *       spawning / running               → violet (workerRunning) — current
 *       completed                        → gold (workerDone) — collapses with prior gold cells; bar appears FULLY gold only when stageIndex === 4 (reviewer)
 *       failed / crashed / timeout       → red (workerFailed)
 *       killed                           → dim gray (workerPaused)
 *   - cells after this worker's stage    → dim gray (textMuted)
 *
 * Glyph: U+2588 FULL BLOCK. Matches the PLAN.md mockup at §3I.
 *
 * The bar is purely presentational — it does NOT subscribe to any
 * timer (unlike `StatusDot`'s flash) and does NOT know about
 * worker-task siblings. Maestro's per-task multi-worker dispatch lands
 * in Phase 4; until then, the bar reads only the worker's own role +
 * status.
 */

const CELL = '█';

export interface PipelineBarProps {
  readonly role: WorkerRole;
  readonly status: WorkerStatus;
}

export function PipelineBar({ role, status }: PipelineBarProps): React.JSX.Element {
  const theme = useTheme();
  const stageIndex = roleToStage(role);
  const cells: React.JSX.Element[] = [];
  for (let i = 0; i < PIPELINE_STAGE_COUNT; i += 1) {
    cells.push(
      <Text key={i} color={theme[cellThemeKey(i, stageIndex, status)]}>
        {CELL}
      </Text>,
    );
  }
  // `flexShrink={0}` is load-bearing: under a narrow Workers panel
  // Ink's flexbox can otherwise shrink a child cell out of the row,
  // surfacing as a 4-cell bar (caught by `tests/scenarios/3i.test.ts`).
  // The bar must always render its full 5-cell width.
  return (
    <Box flexDirection="row" flexShrink={0}>
      {cells}
    </Box>
  );
}

function cellThemeKey(
  cellIndex: number,
  stageIndex: number,
  status: WorkerStatus,
): string {
  if (cellIndex < stageIndex) return 'workerDone';
  if (cellIndex > stageIndex) return 'textMuted';
  // cellIndex === stageIndex
  switch (status) {
    case 'spawning':
    case 'running':
      return 'workerRunning';
    case 'completed':
      return 'workerDone';
    case 'failed':
    case 'crashed':
    case 'timeout':
      return 'workerFailed';
    case 'killed':
      return 'workerPaused';
  }
}
