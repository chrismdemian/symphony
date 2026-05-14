import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box } from 'ink';
import { useTheme } from '../../theme/context.js';
import type { TuiRpc } from '../../runtime/rpc.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import { applyKeybindOverrides } from '../../keybinds/overrides.js';
import { useConfig } from '../../../utils/config-context.js';
import { useToast } from '../../feedback/ToastProvider.js';
import { useResolveWorkerName } from '../../data/InstrumentNameContext.js';
import { WorkerOutputView } from './WorkerOutputView.js';
import { WorkerDiffView } from './WorkerDiffView.js';
import { OutputInlineInput } from './OutputInlineInput.js';
import {
  TERMINAL_WORKER_STATUSES,
  type WorkerRecordSnapshot,
} from '../../../orchestrator/worker-registry.js';

/**
 * Phase 3J — output panel container; toggles between the streaming
 * output view and the worktree diff view via `D`.
 *
 * Responsibilities (deliberately separate from the two view components):
 *   - Owns `viewMode: 'output' | 'diff'`. Resets to `'output'` on
 *     `workerId` change so re-selecting a worker shows the live stream
 *     first.
 *   - Hosts `output.toggleDiff` (D) and `output.refreshDiff` (r). The
 *     toggle is always panel-active when focused; the refresh only
 *     registers while the diff view is mounted.
 *   - Polls `workers.get(workerId)` at 3 s to detect a terminal-status
 *     edge. When the worker transitions non-terminal → terminal AND
 *     the diff view is currently open, bumps `refreshSignal` once so
 *     the diff view re-fetches against the now-final tree.
 *
 * The two views are sibling-rendered with `display: 'none'` swapping
 * via conditional mount (not display swap) so the inactive view's
 * scroll-key registration unmounts cleanly. Output retains its own
 * subscription/backfill state across toggle cycles via the existing
 * `key={workerId}` reset rule (i.e. toggling D and back doesn't lose
 * stream state because the view stays keyed on workerId).
 */

export interface WorkerOutputContainerProps {
  readonly rpc: TuiRpc;
  readonly workerId: string;
  readonly isFocused: boolean;
  /** Test seam: pinned clock for diff view's "captured Ns ago" label. */
  readonly now?: () => number;
  /** Test seam: poll cadence for worker status. <=0 disables polling. */
  readonly statusPollMs?: number;
}

export function WorkerOutputContainer({
  rpc,
  workerId,
  isFocused,
  now,
  statusPollMs,
}: WorkerOutputContainerProps): React.JSX.Element {
  const theme = useTheme();
  const [viewMode, setViewMode] = useState<'output' | 'diff'>('output');
  const [refreshSignal, setRefreshSignal] = useState(0);
  // Phase 3S — Mission Control inject mode. `i` (panel-scoped) flips
  // this on; the inline input renders at the bottom of the panel,
  // submits via `rpc.call.workers.sendTo`, and Esc/onCancel flips it
  // back off. Reset on workerId change so re-selecting a worker
  // doesn't leak the previous inject state across selection.
  const [injectActive, setInjectActive] = useState(false);

  // Reset to streaming output whenever the selected worker changes.
  // Selection stability already remounts the inner views via key, but
  // that doesn't reset the container's own viewMode state.
  useEffect(() => {
    setViewMode('output');
    setInjectActive(false);
  }, [workerId]);

  const toggleDiff = useCallback(() => {
    setViewMode((prev) => (prev === 'diff' ? 'output' : 'diff'));
  }, []);

  const refreshDiff = useCallback(() => {
    setRefreshSignal((n) => n + 1);
  }, []);

  // Mirror viewMode into a ref BEFORE the polling effect so the closure
  // reads the current value at tick time. Declaration order matters:
  // refs are created on first render, but the closure inside the effect
  // resolves identifiers at call time — moving this ABOVE the effect
  // keeps the read-path explicit and matches Symphony's pattern of
  // declaring all refs near the top of the hook block.
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  // ── Auto-refresh on terminal-status edge ─────────────────────────────
  // Poll the worker record at `statusPollMs` (default 3 s) to detect the
  // non-terminal → terminal transition. Lighter than subscribing to the
  // events topic just for status; matches the polling pattern other
  // panels use for list-style RPC reads.
  const effectivePollMs = statusPollMs ?? 3000;
  const lastStatusRef = useRef<WorkerRecordSnapshot['status'] | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (effectivePollMs <= 0) return;
    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      // Defensive: wrap the call in a Promise.resolve() so test fakes
      // that return `undefined` from `vi.fn()` (instead of a Promise)
      // surface as a rejection inside the chain instead of throwing
      // synchronously past `.catch`.
      Promise.resolve()
        .then(() => rpc.call.workers.get(workerId))
        .then((record) => {
          if (cancelled) return;
          if (record === null || record === undefined) return;
          const prev = lastStatusRef.current;
          const next = record.status;
          // Edge detection: non-terminal → terminal AND diff view open.
          if (
            prev !== null &&
            !TERMINAL_WORKER_STATUSES.has(prev) &&
            TERMINAL_WORKER_STATUSES.has(next) &&
            viewModeRef.current === 'diff'
          ) {
            setRefreshSignal((n) => n + 1);
          }
          lastStatusRef.current = next;
        })
        .catch(() => {
          // Status polling errors are non-fatal — just skip this tick.
        })
        .finally(() => {
          inFlightRef.current = false;
        });
    };
    // Fire one immediate tick to capture initial status, then interval.
    tick();
    const handle = setInterval(tick, effectivePollMs);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [rpc, workerId, effectivePollMs]);

  // ── Keybind registration ────────────────────────────────────────────
  const toggleCommand = useMemo<Command>(
    () => ({
      id: 'output.toggleDiff',
      title: viewMode === 'diff' ? 'output' : 'diff',
      key: { kind: 'char', char: 'D' },
      scope: 'output',
      displayOnScreen: true,
      onSelect: toggleDiff,
    }),
    [viewMode, toggleDiff],
  );

  const refreshCommand = useMemo<Command>(
    () => ({
      id: 'output.refreshDiff',
      title: 'refresh',
      key: { kind: 'char', char: 'r' },
      scope: 'output',
      displayOnScreen: true,
      onSelect: refreshDiff,
    }),
    [refreshDiff],
  );

  // Phase 3S — Mission Control inject command. Panel-scoped to `output`,
  // single-letter `i`. Disabled while inject mode is already active so
  // the keystroke doesn't bounce in/out. Listed in the bottom keybind
  // bar to advertise the affordance.
  const injectCommand = useMemo<Command>(
    () => ({
      id: 'output.missionControlInject',
      title: 'inject message',
      key: { kind: 'char', char: 'i' },
      scope: 'output',
      displayOnScreen: true,
      onSelect: () => {
        if (!injectActive) setInjectActive(true);
      },
      ...(injectActive ? { disabledReason: 'inject input is open' } : {}),
    }),
    [injectActive],
  );

  const commands = useMemo<readonly Command[]>(
    () =>
      viewMode === 'diff'
        ? [toggleCommand, refreshCommand]
        : [toggleCommand, injectCommand],
    [viewMode, toggleCommand, refreshCommand, injectCommand],
  );

  const { config } = useConfig();
  const overriddenCommands = useMemo(
    () => applyKeybindOverrides(commands, config.keybindOverrides),
    [commands, config.keybindOverrides],
  );
  // Phase 3S — gate panel-scope command registration while the inline
  // input is active. The OutputInlineInput's own useInput captures all
  // printable keystrokes; suspending command registration means D / r
  // don't fire mid-type even if the user pastes their letters.
  useRegisterCommands(overriddenCommands, isFocused && !injectActive);

  // Phase 3S — Mission Control inject wiring. Resolve the worker's
  // instrument name at render time (3K precedent — the allocator may
  // lag the selection if the user clicks fast). Toast on success/error
  // mirrors the cycleAutonomyTier feedback pattern from commit 4.
  const toast = useToast();
  const resolveName = useResolveWorkerName();
  const handleInjectSubmit = useCallback(
    async (text: string): Promise<void> => {
      try {
        const name = resolveName(workerId) ?? workerId;
        await rpc.call.workers.sendTo({ workerId, message: text });
        toast.showToast(`Sent to ${name}.`, { tone: 'success', ttlMs: 2_500 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.showToast(`Mission Control inject failed: ${msg}`, { tone: 'error' });
      } finally {
        setInjectActive(false);
      }
    },
    [workerId, rpc, resolveName, toast],
  );
  const handleInjectCancel = useCallback(() => {
    setInjectActive(false);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────
  // Note: theme isn't used here directly but kept available for future
  // header chrome (e.g. mode indicator). Mark as referenced for now.
  void theme;

  const body =
    viewMode === 'diff' ? (
      <WorkerDiffView
        rpc={rpc}
        workerId={workerId}
        isFocused={isFocused}
        refreshSignal={refreshSignal}
        {...(now !== undefined ? { now } : {})}
      />
    ) : (
      <WorkerOutputView rpc={rpc} workerId={workerId} isFocused={isFocused} />
    );

  // Phase 3S — wrap body + inline input in a column box. The input
  // mounts only when injectActive, capturing input from the dispatcher
  // exclusive of D / r (gated above). When unmounted, its useInput
  // listener clears so the parent's panel-scope commands re-register.
  return (
    <Box flexDirection="column" width="100%">
      {body}
      {injectActive ? (
        <OutputInlineInput
          workerName={resolveName(workerId) ?? workerId}
          onSubmit={handleInjectSubmit}
          onCancel={handleInjectCancel}
        />
      ) : null}
    </Box>
  );
}
