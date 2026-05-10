import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import { Equalizer } from '../../anim/Equalizer.js';
import type { TuiRpc } from '../../runtime/rpc.js';
import { useWorkerDiff, type WorkerDiffState } from '../../data/useWorkerDiff.js';
import { DiffBody } from './DiffBody.js';
import type { WorkersDiffFile, WorkersDiffResult } from '../../../rpc/router-impl.js';

/**
 * Phase 3J — diff view body. Renders one of three top-level states:
 *   - `loading` — spinner + "Computing diff…" hint. Re-uses `Equalizer`
 *     from the streaming view's spinner so the visual style matches.
 *   - `error` — red banner with the error message. Shows previous data
 *     underneath when available so the user can still read the prior
 *     diff.
 *   - `ready` — header (Diff vs base@sha · file count · bytes ·
 *     captured Ns ago), file-list summary, optional truncation banner,
 *     scrollable diff body.
 *
 * Layout decision: file list is rendered as a single muted-gray summary
 * row when files.length > 0 (e.g., `5 files: 2M 1A 1D 1??`). Full
 * per-path enumeration is omitted to keep the chrome compact — diff
 * bodies already include `+++ b/path` / `--- a/path` headers per file.
 *
 * `now` is parameterized so the visual harness can render deterministic
 * "captured Ns ago" labels.
 */

export interface WorkerDiffViewProps {
  readonly rpc: TuiRpc;
  readonly workerId: string;
  readonly isFocused: boolean;
  /** Test seam: pinned clock for relative timestamps. */
  readonly now?: () => number;
  /**
   * Test seam: pre-supplied state (skips the hook). Used by the visual
   * harness to render canonical scenarios without an RPC roundtrip.
   */
  readonly stateOverride?: WorkerDiffState;
  /**
   * Bumped by the container when an external trigger (worker terminal
   * status edge, user `r` press) wants the hook to re-fetch. Each
   * increment fires one refresh.
   */
  readonly refreshSignal?: number;
}

export function WorkerDiffView({
  rpc,
  workerId,
  isFocused,
  now,
  stateOverride,
  refreshSignal,
}: WorkerDiffViewProps): React.JSX.Element {
  const hookResult = useWorkerDiff(
    rpc,
    workerId,
    now !== undefined
      ? { enabled: stateOverride === undefined, now }
      : { enabled: stateOverride === undefined },
  );
  const state = stateOverride ?? hookResult.state;
  const refresh = hookResult.refresh;

  // Refresh signal — fires `refresh()` once per increment.
  const lastSignalRef = React.useRef<number | undefined>(refreshSignal);
  React.useEffect(() => {
    if (refreshSignal === undefined) return;
    if (lastSignalRef.current !== refreshSignal) {
      lastSignalRef.current = refreshSignal;
      refresh();
    }
  }, [refreshSignal, refresh]);

  return <DiffViewStateless state={state} isFocused={isFocused} now={now ?? Date.now} />;
}

interface DiffViewStatelessProps {
  readonly state: WorkerDiffState;
  readonly isFocused: boolean;
  readonly now: () => number;
}

function DiffViewStateless({ state, isFocused, now }: DiffViewStatelessProps): React.JSX.Element {
  const theme = useTheme();

  if (state.kind === 'idle') {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text color={theme['textMuted']}>(diff view inactive)</Text>
      </Box>
    );
  }

  if (state.kind === 'loading' && state.previous === undefined) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Box>
          <Equalizer />
          <Text color={theme['textMuted']}>{'  '}Computing diff…</Text>
        </Box>
      </Box>
    );
  }

  // Loading-with-previous, ready, error-with-previous, or error-no-data
  // all converge on the same chrome layout. The "live" data driving the
  // body is whichever copy we have closest to fresh.
  const data: WorkersDiffResult | null =
    state.kind === 'ready'
      ? state.data
      : state.kind === 'loading'
        ? (state.previous ?? null)
        : state.kind === 'error'
          ? (state.previous ?? null)
          : null;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {data !== null ? (
        <>
          <DiffHeader
            data={data}
            fetchedAt={state.kind === 'ready' ? state.fetchedAt : undefined}
            now={now}
            stale={state.kind !== 'ready'}
          />
          {data.truncated ? (
            <Text color={theme['warning']}>
              ⚠ Diff truncated at {(data.cappedAt ?? data.bytes).toLocaleString()} bytes
              (total {data.bytes.toLocaleString()} bytes) — finalize the worker for the full diff
            </Text>
          ) : null}
        </>
      ) : null}
      {state.kind === 'error' ? (
        <Text color={theme['error']}>
          ✗ {state.error.message} — press r to retry
        </Text>
      ) : null}
      {state.kind === 'loading' && state.previous !== undefined ? (
        <Box>
          <Equalizer />
          <Text color={theme['textMuted']}>{'  '}Refreshing…</Text>
        </Box>
      ) : null}
      {data !== null ? (
        data.diff.length === 0 ? (
          <Text color={theme['textMuted']}>
            (no changes vs {data.resolvedBase}@{shortSha(data.mergeBaseSha)})
          </Text>
        ) : (
          <DiffBody source={data.diff} isFocused={isFocused} />
        )
      ) : null}
    </Box>
  );
}

interface DiffHeaderProps {
  readonly data: WorkersDiffResult;
  readonly fetchedAt: number | undefined;
  readonly now: () => number;
  readonly stale: boolean;
}

function DiffHeader({ data, fetchedAt, now, stale }: DiffHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const fileSummary = formatFileSummary(data.files);
  const ageText =
    fetchedAt !== undefined ? ` · captured ${formatRelative(now() - fetchedAt)}` : '';
  return (
    <Box flexDirection="column">
      <Text color={theme['accent']}>
        Diff vs {data.resolvedBase}@{shortSha(data.mergeBaseSha)} · {fileSummary} ·{' '}
        {data.bytes.toLocaleString()} bytes{ageText}
        {stale ? ' (stale)' : ''}
      </Text>
    </Box>
  );
}

function formatFileSummary(files: readonly WorkersDiffFile[]): string {
  if (files.length === 0) return '0 files';
  const counts = new Map<string, number>();
  for (const f of files) {
    counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [status, count] of [...counts.entries()].sort()) {
    parts.push(`${count}${status}`);
  }
  const total = files.length;
  return `${total} file${total === 1 ? '' : 's'}: ${parts.join(' ')}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function formatRelative(deltaMs: number): string {
  if (deltaMs < 0) return 'just now';
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
