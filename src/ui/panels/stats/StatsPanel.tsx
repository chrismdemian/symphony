import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import { useFocus } from '../../focus/focus.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import type { TuiRpc } from '../../runtime/rpc.js';
import type {
  StatsByProjectRow,
  StatsByWorkerRow,
} from '../../../rpc/router-impl.js';
import {
  EMPTY_SESSION_TOTALS,
  formatCostUsd,
  formatTokenCount,
  type SessionTotals,
} from '../../../orchestrator/session-totals.js';

/**
 * Phase 3N.3 — `/stats` popup. Three stacked sections:
 *   1. Session: cumulative this-orchestrator-boot totals + workerCount
 *   2. By Project: per-project rollup, sorted by cost desc
 *   3. Recent Workers: last N workers with per-worker breakdown
 *
 * Polled at 2s while open (mirrors `<QuestionHistory>`'s cadence —
 * historical data changes more slowly than the live workers panel's
 * 1s feed). Unmounts on close → polling stops naturally.
 *
 * Hand-built; the TUI shell stays non-generative per PLAN.md §3
 * "json-render is for worker-emitted content, not chrome".
 */

const SCOPE = 'stats';
const BY_WORKER_LIMIT = 50;

export interface StatsPanelProps {
  readonly rpc: TuiRpc;
}

interface StatsData {
  readonly session: SessionTotals;
  readonly byProject: readonly StatsByProjectRow[];
  readonly byWorker: readonly StatsByWorkerRow[];
}

const EMPTY_DATA: StatsData = {
  session: EMPTY_SESSION_TOTALS,
  byProject: [],
  byWorker: [],
};

function formatCostOrDash(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return formatCostUsd(n);
}

interface StatusGlyph {
  readonly glyph: string;
  /** Theme color tier — matches the established StatusDot + Bubble conventions. */
  readonly tone: 'success' | 'error' | 'warning' | 'accent' | 'muted';
}

/**
 * Status glyph + color mapping. Matches `StatusDot` (workers panel) and
 * `Bubble` (chat completion rows) so the same status renders the same
 * glyph + color across every Symphony surface. Audit 3N.3 M1/M2/M3:
 * - `completed` → ✓ gold (matches workerDone + Bubble success)
 * - `timeout` → ⏱ warning gold (matches StatusDot + Bubble; semantically
 *   distinct from a hard failure)
 * - `failed` / `crashed` → ✗ red (matches workerFailed)
 * - `killed` → ⊘ muted gray (matches workerPaused; user-initiated, not
 *   a failure)
 * - `running` → ● accent (no chat/dot precedent for transient states
 *   in this exact place; accent works)
 * - `spawning` → ◌ muted (transient, low-signal)
 */
function statusGlyphFor(status: string): StatusGlyph {
  switch (status) {
    case 'completed':
      return { glyph: '✓', tone: 'success' };
    case 'running':
      return { glyph: '●', tone: 'accent' };
    case 'spawning':
      return { glyph: '◌', tone: 'muted' };
    case 'failed':
    case 'crashed':
      return { glyph: '✗', tone: 'error' };
    case 'timeout':
      return { glyph: '⏱', tone: 'warning' };
    case 'killed':
      return { glyph: '⊘', tone: 'muted' };
    default:
      return { glyph: '·', tone: 'muted' };
  }
}

export function StatsPanel({ rpc }: StatsPanelProps): React.JSX.Element {
  const theme = useTheme();
  const focus = useFocus();
  const isFocused = focus.currentScope === SCOPE;
  const popPopup = focus.popPopup;
  const [data, setData] = useState<StatsData>(EMPTY_DATA);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState<number>(0);
  const inFlightRef = useRef(false);
  // Audit 3N.3 M4 — mirror useQueue's pendingRefreshRef pattern from
  // 3L. Without this, a polling tick that fires while a slow fetch is
  // still in flight (e.g., 500+ persisted workers) gets dropped and
  // polling stalls until the next interval. Recording the deferred
  // refresh and re-bumping `tick` in the in-flight `.finally` drains
  // the dropped tick without waiting for the next interval.
  const pendingRefreshRef = useRef(false);

  // Poll every 2s while the popup is open. Same cadence as
  // QuestionHistory; historical-data churn rate doesn't demand 1s.
  useEffect(() => {
    if (!isFocused) return;
    const handle = setInterval(() => setTick((n) => n + 1), 2_000);
    return () => clearInterval(handle);
  }, [isFocused]);

  useEffect(() => {
    if (inFlightRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    let cancelled = false;
    inFlightRef.current = true;
    setLoading(true);
    void (async () => {
      try {
        const [session, byProject, byWorker] = await Promise.all([
          rpc.call.stats.session(),
          rpc.call.stats.byProject(),
          rpc.call.stats.byWorker({ limit: BY_WORKER_LIMIT }),
        ]);
        if (cancelled) return;
        setData({ session, byProject, byWorker });
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlightRef.current = false;
        if (!cancelled) {
          setLoading(false);
          if (pendingRefreshRef.current) {
            pendingRefreshRef.current = false;
            setTick((n) => n + 1);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, tick]);

  const commands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'stats.dismiss',
        title: 'close',
        key: { kind: 'escape' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => popPopup(),
      },
    ],
    [popPopup],
  );
  useRegisterCommands(commands, isFocused);

  const headlineTokens = useMemo(
    () => formatTokenCount(data.session.totalTokens),
    [data.session.totalTokens],
  );
  const headlineCost = useMemo(
    () => formatCostUsd(data.session.totalCostUsd),
    [data.session.totalCostUsd],
  );

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor={theme['accent']}
      paddingX={1}
    >
      <Box flexDirection="row" marginBottom={1}>
        <Text color={theme['accent']} bold>
          Session statistics
        </Text>
        {loading && (
          <Text color={theme['textMuted']}> · loading</Text>
        )}
      </Box>
      {error !== null && (
        <Box marginBottom={1}>
          <Text color={theme['error']}>Failed to load stats: {error}</Text>
        </Box>
      )}

      {/* Session headline */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme['textMuted']}>
          Session: <Text color={theme['accent']}>{headlineTokens}</Text>
          <Text color={theme['textMuted']}> tokens · </Text>
          <Text color={theme['accent']}>{headlineCost}</Text>
          <Text color={theme['textMuted']}>
            {' '}across {data.session.workerCount}{' '}
            {data.session.workerCount === 1 ? 'worker' : 'workers'}
          </Text>
        </Text>
        {(data.session.cacheReadTokens > 0 || data.session.cacheWriteTokens > 0) && (
          <Text color={theme['textMuted']}>
            {'  '}cache: {formatTokenCount(data.session.cacheReadTokens)} read ·{' '}
            {formatTokenCount(data.session.cacheWriteTokens)} write
          </Text>
        )}
      </Box>

      {/* By Project */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme['accent']} bold>
          By project
        </Text>
        {data.byProject.length === 0 ? (
          <Text color={theme['textMuted']}>{'  '}(no billed activity yet)</Text>
        ) : (
          data.byProject.map((row) => (
            <Box key={row.projectId ?? '__unregistered__'} flexDirection="row">
              <Text color={theme['textMuted']}>{'  '}</Text>
              <Text color={theme['text']}>{row.projectName}</Text>
              <Text color={theme['textMuted']}>
                {' '}· {row.workerCount}{' '}
                {row.workerCount === 1 ? 'worker' : 'workers'}{' '}·{' '}
              </Text>
              <Text color={theme['accent']}>{formatTokenCount(row.totalTokens)}</Text>
              <Text color={theme['textMuted']}> tokens · </Text>
              <Text color={theme['accent']}>{formatCostUsd(row.totalCostUsd)}</Text>
            </Box>
          ))
        )}
      </Box>

      {/* Recent workers */}
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme['accent']} bold>
          Recent workers
          <Text color={theme['textMuted']}>
            {' '}· last {Math.min(BY_WORKER_LIMIT, data.byWorker.length)}
          </Text>
        </Text>
        {data.byWorker.length === 0 ? (
          <Text color={theme['textMuted']}>{'  '}(no workers tracked)</Text>
        ) : (
          data.byWorker.slice(0, 12).map((row) => {
            const { glyph, tone } = statusGlyphFor(row.status);
            const glyphColor =
              tone === 'error'
                ? theme['error']
                : tone === 'warning'
                  ? theme['warning']
                  : tone === 'success'
                    ? theme['success']
                    : tone === 'muted'
                      ? theme['textMuted']
                      : theme['accent'];
            const input = row.inputTokens;
            const output = row.outputTokens;
            const totalTokens = (input ?? 0) + (output ?? 0);
            return (
              <Box key={row.workerId} flexDirection="row">
                <Text color={theme['textMuted']}>{'  '}</Text>
                <Text color={glyphColor}>{glyph}</Text>
                <Text color={theme['text']}> {row.featureIntent || row.workerId}</Text>
                <Text color={theme['textMuted']}> · {row.projectName} · </Text>
                <Text color={theme['accent']}>
                  {input === null && output === null ? '—' : formatTokenCount(totalTokens)}
                </Text>
                <Text color={theme['textMuted']}> · </Text>
                <Text color={theme['accent']}>{formatCostOrDash(row.costUsd)}</Text>
              </Box>
            );
          })
        )}
        {data.byWorker.length > 12 && (
          <Text color={theme['textMuted']}>
            {'  '}… {data.byWorker.length - 12} more
          </Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme['textMuted']}>Esc to close</Text>
      </Box>
    </Box>
  );
}

