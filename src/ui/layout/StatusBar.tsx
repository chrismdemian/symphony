import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/context.js';
import type { ProjectSnapshot } from '../../projects/types.js';
import type { WorkerRecordSnapshot } from '../../orchestrator/worker-registry.js';
import type { AutonomyTier, ToolMode } from '../../orchestrator/types.js';
import {
  formatCostUsd,
  formatTokenCount,
  type SessionTotals,
} from '../../orchestrator/session-totals.js';

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
  /**
   * Phase 3M — when true, an "Away Mode — N done, N pending, N questions
   * queued" segment renders between `Project` and `Session`. The locked
   * muted-gray text token signals the away state (PLAN.md §3M:1320).
   */
  readonly awayMode?: boolean;
  /**
   * Phase 3M — pending queue count for the Away Mode segment. Sourced
   * from `useQueue` at the App level; defaults to 0 (no segment row when
   * queueResult was omitted).
   */
  readonly pendingQueueCount?: number;
  /**
   * Phase 3N.2 — cumulative session totals (tokens + cost). When both
   * `totalTokens` and `totalCostUsd` are 0, the segment is hidden
   * entirely to avoid splash-state noise. The token figure displayed is
   * `inputTokens + outputTokens` (cache counts visible in `/stats`).
   */
  readonly sessionTotals?: SessionTotals;
  /**
   * Phase 3S — global autonomy tier. Always rendered (unlike awayMode
   * which only shows when on); tier is critical safety state and the
   * chip is the canonical UI surface. Defaults to `2` (Notify) which
   * matches the schema default. Cycled via Ctrl+Y.
   */
  readonly autonomyTier?: AutonomyTier;
}

function activeCount(workers: readonly WorkerRecordSnapshot[]): number {
  let n = 0;
  for (const w of workers) {
    if (!TERMINAL_STATUSES.has(w.status)) n++;
  }
  return n;
}

/**
 * Phase 3M — count "done" workers (completed terminal state only — not
 * failed/killed/timeout/crashed). PLAN.md §3M:1320's "N done" copy
 * implies successful completions; the other terminal states are
 * surfaced through their own channels (notifications, system rows).
 */
function doneCount(workers: readonly WorkerRecordSnapshot[]): number {
  let n = 0;
  for (const w of workers) {
    if (w.status === 'completed') n++;
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

/**
 * Phase 3S — autonomy-tier chip color mapping. Color semantics here are
 * "attention required to use a flagged tool", rising:
 *   - Tier 1 (Free reign)  → gold/primary — positive/active, you trust it.
 *   - Tier 2 (Notify)      → violet/accent — mid-way, first-use heads-ups.
 *   - Tier 3 (Confirm)     → gold-light/warning (amber) — needs attention.
 *
 * Note that this is the OPPOSITE of risk semantics (Tier 1 is the most
 * autonomous, hence riskiest). Aligning to "user attention" rather than
 * "risk" matches how PLAN.md §3S describes the dial.
 */
function tierLabel(tier: AutonomyTier): string {
  return tier === 1 ? 'Free' : tier === 2 ? 'Notify' : 'Confirm';
}

function tierColor(theme: Record<string, string>, tier: AutonomyTier): string {
  if (tier === 1) return theme['primary']!;
  if (tier === 2) return theme['accent']!;
  return theme['warning']!;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const theme = useTheme();
  const active = activeCount(props.workers);
  const questionsCount = props.questionsCount ?? 0;
  const blockingCount = props.blockingCount ?? 0;
  const awayMode = props.awayMode === true;
  const done = doneCount(props.workers);
  const pending = props.pendingQueueCount ?? 0;
  // Phase 3N.2 — segment visibility: hidden until at least one worker
  // has contributed tokens or cost. Mid-session 0/0 happens only on
  // splash / pre-first-spawn; once anything bills, the segment stays.
  const totals = props.sessionTotals;
  const showUsageSegment =
    totals !== undefined && (totals.totalTokens > 0 || totals.totalCostUsd > 0);
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
      {showUsageSegment && totals !== undefined && (
        <Box flexShrink={0}>
          {/*
           * Phase 3N.2 — `↑ {tokens} · ${cost}` segment. The up-arrow
           * is the universal "outbound traffic" glyph. Label is muted
           * (chrome); values are accent (signal) so the eye lands on
           * the magnitudes. Token count uses `inputTokens +
           * outputTokens` only — cache counts surface in `/stats`
           * (Phase 3N.3).
           *
           * Audit M4 (3N.2): wrap in `<Box flexShrink={0}>` so Ink's
           * flex-row layout cannot chop the segment under width
           * pressure (3I rule). The surrounding `<Text>` siblings in
           * this bar still flex-shrink — adding the wrapper here pins
           * the new segment specifically; other segments retain their
           * pre-existing behavior. Position stays between Workers and
           * Q because the Box renders inline in the row.
           */}
          <Text color={theme['border']}>{SEPARATOR}</Text>
          <Text color={theme['textMuted']}>↑ </Text>
          <Text color={theme['accent']}>{formatTokenCount(totals.totalTokens)}</Text>
          <Text color={theme['textMuted']}> · </Text>
          <Text color={theme['accent']}>{formatCostUsd(totals.totalCostUsd)}</Text>
        </Box>
      )}
      <Text color={theme['border']}>{SEPARATOR}</Text>
      <Text color={theme['textMuted']}>Q: </Text>
      <Text color={questionsColor(theme, questionsCount, blockingCount)}>
        {String(questionsCount)}
      </Text>
      <Text color={theme['border']}>{SEPARATOR}</Text>
      <Text color={theme['textMuted']}>Project: </Text>
      <Text color={theme['text']}>{formatProject(props.projects)}</Text>
      {awayMode && (
        <>
          <Text color={theme['border']}>{SEPARATOR}</Text>
          {/*
           * Phase 3M — Away Mode segment. Muted-gray throughout per
           * PLAN.md §3M:1320 ("no emoji glyph; the bar's status segment
           * uses the locked muted-gray text token to signal away
           * state"). The whole label including counts stays one
           * uniform tone — no accent color on numbers — because the
           * away state itself is the signal, not the magnitudes.
           */}
          <Text color={theme['textMuted']}>
            Away Mode — {done} done, {pending} pending, {questionsCount}{' '}
            {questionsCount === 1 ? 'question' : 'questions'} queued
          </Text>
        </>
      )}
      {props.sessionId !== null && (
        <>
          <Text color={theme['border']}>{SEPARATOR}</Text>
          <Text color={theme['textMuted']}>Session: </Text>
          <Text color={theme['text']}>{props.sessionId.slice(0, 8)}</Text>
        </>
      )}
      {/*
       * Phase 3S — autonomy tier chip. Always renders (unlike the
       * conditional awayMode segment); tier is a critical safety
       * setting that should be persistently visible. Defaults to Tier 2
       * (Notify) — matches the schema default + DEFAULT_DISPATCH_CONTEXT
       * in capabilities.ts. Cycled via Ctrl+Y (`app.cycleAutonomyTier`).
       *
       * Rendered as flat <Text> siblings (NOT wrapped in a Box) to match
       * the awayMode segment's render shape — wrapping the chip in a
       * <Box flexShrink={0}> interleaves with Ink's text-wrap algorithm
       * under narrow widths, causing the bar's continuation lines to
       * land mid-Away-segment ("3 │ T2 Notify ny : ) questions"). Flat
       * Text siblings flow naturally with the rest of the bar. Position
       * assertions belong in the visual harness (120-col fixed width),
       * not unit tests where ink-testing-library wraps.
       */}
      <Text color={theme['border']}>{SEPARATOR}</Text>
      <Text color={tierColor(theme, props.autonomyTier ?? 2)}>
        T{props.autonomyTier ?? 2} {tierLabel(props.autonomyTier ?? 2)}
      </Text>
    </Box>
  );
}
