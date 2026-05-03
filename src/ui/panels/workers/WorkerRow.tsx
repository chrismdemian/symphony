import React from 'react';
import { Box, Text } from 'ink';
import type { WorkerRecordSnapshot } from '../../../orchestrator/worker-registry.js';
import { useTheme } from '../../theme/context.js';
import { StatusDot } from './StatusDot.js';

/**
 * Single-line representation of a worker.
 *
 * Layout (left → right):
 *   [dot] [instrument] [feature-intent (truncated)] [model] [runtime]
 *
 * Selected rows render with `inverse` styling — readable in every
 * terminal regardless of theme.
 *
 * Width budget for `featureIntent` is delegated to the parent; this row
 * receives a pre-truncated string. The row itself never measures
 * terminal width (avoids cascading re-layout on resize).
 */

export interface WorkerRowProps {
  readonly worker: WorkerRecordSnapshot;
  readonly instrument: string;
  readonly selected: boolean;
  readonly featureIntentDisplay: string;
  readonly runtimeDisplay: string;
}

export function WorkerRow({
  worker,
  instrument,
  selected,
  featureIntentDisplay,
  runtimeDisplay,
}: WorkerRowProps): React.JSX.Element {
  const theme = useTheme();
  const modelLabel = formatModel(worker.model);
  // Visual review C1/M1/M2 (3c #1):
  //   - feature-intent renders in `text` (light gray) so the row's
  //     primary content owns the visual hierarchy, not the muted-gray
  //     metadata cells.
  //   - The inverse highlight on the selected row wraps ONLY the
  //     instrument glyphs (no trailing padded whitespace) — inverse on
  //     padding produces a "block tab" of solid color past the visible
  //     text.
  //   - The leading gutter is a literal space (no color attribute on
  //     the non-selected branch) so non-selected rows don't render a
  //     dim-gray pixel column against the panel background.
  const padding = ' '.repeat(Math.max(0, 8 - instrument.length));
  return (
    <Box flexDirection="row">
      {selected ? (
        <Text color={theme['accent']}>▌</Text>
      ) : (
        <Text> </Text>
      )}
      <Text> </Text>
      <StatusDot status={worker.status} />
      <Text> </Text>
      {selected ? (
        <Text color={theme['text']} inverse bold>
          {instrument}
        </Text>
      ) : (
        <Text color={theme['text']}>{instrument}</Text>
      )}
      <Text>{padding}</Text>
      <Text color={theme['text']}> {featureIntentDisplay}</Text>
      <Box flexGrow={1} />
      {modelLabel !== '' ? (
        <Text color={theme['textMuted']}> {modelLabel} </Text>
      ) : null}
      <Text color={theme['textMuted']}>{runtimeDisplay}</Text>
    </Box>
  );
}

function formatModel(model: string | undefined): string {
  if (model === undefined || model === '') return '';
  // Trim provider prefix and version suffix for compactness:
  //   `claude-opus-4-7` → `Opus`
  //   `claude-sonnet-4-6` → `Sonnet`
  //   `claude-haiku-4-5-20251001` → `Haiku`
  const m = /^(?:claude-)?(opus|sonnet|haiku)\b/i.exec(model);
  if (m && m[1] !== undefined) {
    return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  }
  return model.length <= 8 ? model : `${model.slice(0, 7)}…`;
}

/**
 * Format an ISO timestamp into a compact runtime label relative to a
 * reference time. Returns `'—'` for missing input.
 *
 *   <60s    → `Ns`
 *   <60m    → `Nm`
 *   ≥60m    → `Hh Mm`
 */
export function formatRuntime(createdAt: string, nowMs: number): string {
  if (createdAt === '') return '—';
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return '—';
  const elapsedMs = Math.max(0, nowMs - created);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}
