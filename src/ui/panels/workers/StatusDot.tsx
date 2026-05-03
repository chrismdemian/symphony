import React from 'react';
import { Text, useAnimation } from 'ink';
import type { WorkerStatus } from '../../../workers/types.js';
import { useTheme } from '../../theme/context.js';

/**
 * Single-character status dot for a worker row.
 *
 * Plan rule (PLAN.md:1076-1077): active workers FLASH; idle/done workers
 * are SOLID. Active = `spawning | running`. Everything else (terminal
 * statuses) renders solid. The flash is a glyph toggle (`●` ↔ `○`) at
 * 500 ms — color toggles read as visually noisy in some terminals, glyph
 * toggles are unambiguous.
 *
 * Future-status hooks (commented): when the worker status union grows
 * to include `planning`, `needsReview`, `needsInput`, `paused`
 * (introduced by Phase 4 reviewer / 3E ask_user / a future pause primitive),
 * extend the symbol+color tables. Theme tokens are already locked
 * (`workerPlanning`, `workerReview`, `workerNeedsInput`, `workerPaused`).
 */

const FLASH_INTERVAL_MS = 500;

const ACTIVE_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
  'spawning',
  'running',
]);

interface StatusVisual {
  readonly symbol: string;
  readonly themeKey: string;
}

function visualForStatus(status: WorkerStatus): StatusVisual {
  switch (status) {
    case 'spawning':
    case 'running':
      return { symbol: '●', themeKey: 'workerRunning' };
    case 'completed':
      return { symbol: '✓', themeKey: 'workerDone' };
    case 'failed':
    case 'crashed':
      return { symbol: '✗', themeKey: 'workerFailed' };
    case 'killed':
      return { symbol: '⊘', themeKey: 'workerPaused' };
    case 'timeout':
      return { symbol: '⏱', themeKey: 'warning' };
  }
}

export interface StatusDotProps {
  readonly status: WorkerStatus;
}

export function StatusDot({ status }: StatusDotProps): React.JSX.Element {
  const theme = useTheme();
  const visual = visualForStatus(status);
  const isActive = ACTIVE_STATUSES.has(status);
  // Subscribe to the animation timer only when active; idle dots render
  // solid without consuming a timer slot.
  const { frame } = useAnimation({ interval: FLASH_INTERVAL_MS });
  const showSolid = !isActive || frame % 2 === 0;
  const glyph = isActive ? (showSolid ? '●' : '○') : visual.symbol;
  return <Text color={theme[visual.themeKey]}>{glyph}</Text>;
}
