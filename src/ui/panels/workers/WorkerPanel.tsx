import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useAnimation } from 'ink';
import type { WorkerRecordSnapshot } from '../../../orchestrator/worker-registry.js';
import type { PendingSpawnSnapshot } from '../../../rpc/router-impl.js';
import { Panel } from '../../layout/Panel.js';
import { useTheme } from '../../theme/context.js';
import { useFocus } from '../../focus/focus.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import { applyKeybindOverrides } from '../../keybinds/overrides.js';
import { useConfig } from '../../../utils/config-context.js';
import {
  deriveDisplayName,
  useProjectGroups,
  type ProjectGroup,
} from '../../data/useProjectGroups.js';
import { useInstrumentNames } from '../../data/useInstrumentNames.js';
import { useWorkerSelection } from '../../data/WorkerSelection.js';
import type { UseQueueResult } from '../../data/useQueue.js';
import { useToast } from '../../feedback/ToastProvider.js';
import type { TuiRpc } from '../../runtime/rpc.js';
import type { UseWorkersResult } from '../../data/useWorkers.js';
import { ProjectGroupHeader } from './ProjectGroupHeader.js';
import { QueueHeader } from './QueueHeader.js';
import { QueueRow } from './QueueRow.js';
import { WorkerRow, formatRuntime } from './WorkerRow.js';

/**
 * Phase 3C worker panel.
 *
 * Visual structure:
 *   ╭ Workers ──────────────────────────────╮
 *   │  ▾ MathScrabble (3 workers, 2 active) │
 *   │   ●  Violin   implementing fronte… Op  3m
 *   │   ●  Cello    planning API        So  2m
 *   │   ✓  Flute    tests passed        Op  8m
 *   │  ▸ CRE Pipeline (1 worker)            │
 *   ╰───────────────────────────────────────╯
 *
 * Visible rows:
 *   - Group headers always render.
 *   - Workers under collapsed groups are hidden.
 *   - Selection cycles through visible rows (headers + workers).
 *
 * Keybinds (panel scope `'workers'`):
 *   - j / ↓        next visible row
 *   - k / ↑        prev visible row
 *   - 1-9          select Nth visible WORKER (skips headers)
 *   - Enter        on a header: toggle collapse; on a worker: no-op
 *                  (selection already happened via nav)
 *   - K            workers.kill on the selected worker
 *   - R            disabled — Maestro-only resume_worker (Phase 4)
 *   - P            disabled — no pause primitive yet
 */

const SCOPE = 'workers';
const QUEUE_KEY = '__symphony.queue';
const FEATURE_INTENT_BUDGET = 30;

type VisibleRow =
  | { readonly kind: 'header'; readonly group: ProjectGroup }
  | {
      readonly kind: 'worker';
      readonly group: ProjectGroup;
      readonly worker: WorkerRecordSnapshot;
    }
  | { readonly kind: 'queue-header'; readonly count: number }
  | {
      readonly kind: 'queue-item';
      readonly pending: PendingSpawnSnapshot;
      readonly ordinal: number;
    };

export interface WorkerPanelProps {
  readonly rpc: TuiRpc;
  readonly workersResult: UseWorkersResult;
  /**
   * Phase 3L — pending queue snapshot, polled at App level. Optional
   * so legacy test rigs that mount this panel without queue data keep
   * compiling. Tests construct a minimal `UseQueueResult` stub.
   */
  readonly queueResult?: UseQueueResult;
}

const EMPTY_QUEUE: UseQueueResult = {
  pending: [],
  loading: false,
  error: null,
  refresh: () => undefined,
};

export function WorkerPanel({
  rpc,
  workersResult,
  queueResult,
}: WorkerPanelProps): React.JSX.Element {
  const queue = queueResult ?? EMPTY_QUEUE;
  const theme = useTheme();
  const focus = useFocus();
  // Phase 3E: derive from `currentScope` so panel-scope ordinal/J/K/Enter
  // commands silently disable while a popup is on top of the workers
  // panel. Symmetry with ChatPanel's same change.
  const isFocused = focus.currentScope === SCOPE;
  const { workers, error } = workersResult;
  const groups = useProjectGroups(workers);
  const instruments = useInstrumentNames(workers);
  const selection = useWorkerSelection();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedHeader, setSelectedHeader] = useState<string | null>(null);
  const [selectedQueueRecordId, setSelectedQueueRecordId] = useState<string | null>(null);
  const [killNotice, setKillNotice] = useState<string | null>(null);
  const { showToast } = useToast();

  const queueCollapsed = collapsed.has(QUEUE_KEY);
  const isQueueHeaderSelected = selectedHeader === QUEUE_KEY;

  const { visibleRows, visibleWorkerIds } = useMemo(() => {
    const rows: VisibleRow[] = [];
    const ids: string[] = [];
    for (const group of groups) {
      rows.push({ kind: 'header', group });
      if (collapsed.has(group.projectPath)) continue;
      for (const w of group.workers) {
        rows.push({ kind: 'worker', group, worker: w });
        ids.push(w.id);
      }
    }
    if (queue.pending.length > 0) {
      rows.push({ kind: 'queue-header', count: queue.pending.length });
      if (!collapsed.has(QUEUE_KEY)) {
        queue.pending.forEach((pending, idx) => {
          rows.push({ kind: 'queue-item', pending, ordinal: idx + 1 });
        });
      }
    }
    return { visibleRows: rows, visibleWorkerIds: ids };
  }, [groups, collapsed, queue.pending]);

  // Reconcile selection when the worker id set changes.
  useEffect(() => {
    selection.reconcile(visibleWorkerIds);
  }, [selection, visibleWorkerIds]);

  // Auto-clear header-selection when the targeted group disappears.
  // The QUEUE_KEY header is exempt — it auto-clears via the queue
  // emptiness check just below.
  useEffect(() => {
    if (selectedHeader === null || selectedHeader === QUEUE_KEY) return;
    if (!groups.some((g) => g.projectPath === selectedHeader)) {
      setSelectedHeader(null);
    }
  }, [selectedHeader, groups]);

  // Phase 3L — auto-clear queue selections when the queue empties.
  // The collapsed state is preserved across emptying so a user who
  // collapsed the queue keeps it collapsed when new items arrive.
  useEffect(() => {
    if (queue.pending.length > 0) return;
    if (selectedHeader === QUEUE_KEY) setSelectedHeader(null);
    if (selectedQueueRecordId !== null) setSelectedQueueRecordId(null);
  }, [queue.pending.length, selectedHeader, selectedQueueRecordId]);

  // Auto-clear queue-item selection when its recordId leaves pending
  // (drained, cancelled, or rerouted). Mirrors the header auto-clear.
  useEffect(() => {
    if (selectedQueueRecordId === null) return;
    if (!queue.pending.some((p) => p.recordId === selectedQueueRecordId)) {
      setSelectedQueueRecordId(null);
    }
  }, [selectedQueueRecordId, queue.pending]);

  // Auto-clear kill notice after 2s so it doesn't stick around forever.
  useEffect(() => {
    if (killNotice === null) return;
    const handle = setTimeout(() => setKillNotice(null), 2000);
    return () => clearTimeout(handle);
  }, [killNotice]);

  const currentRowIndex = useMemo(() => {
    if (selectedHeader === QUEUE_KEY) {
      return visibleRows.findIndex((r) => r.kind === 'queue-header');
    }
    if (selectedHeader !== null) {
      return visibleRows.findIndex(
        (r) => r.kind === 'header' && r.group.projectPath === selectedHeader,
      );
    }
    if (selectedQueueRecordId !== null) {
      return visibleRows.findIndex(
        (r) => r.kind === 'queue-item' && r.pending.recordId === selectedQueueRecordId,
      );
    }
    if (selection.selectedId !== null) {
      return visibleRows.findIndex(
        (r) => r.kind === 'worker' && r.worker.id === selection.selectedId,
      );
    }
    return -1;
  }, [visibleRows, selectedHeader, selectedQueueRecordId, selection.selectedId]);

  // Three-way mutex helpers — render-time checks (in each row's
  // `isSelected` derivation) enforce that exactly one row shows
  // selected at any time. We do NOT call `selection.setSelectedId(null)`
  // here: the WorkerSelectionProvider's reconcile effect (`reconcile`
  // fires whenever the controller's identity changes after a dispatch)
  // would immediately revert selectedId back to the first visible
  // worker, racing the selection set. Letting `selection.selectedId`
  // linger is safe because the worker row's `isSelected` gates on
  // `selectedHeader === null && selectedQueueRecordId === null`.
  const selectWorker = useCallback(
    (workerId: string) => {
      setSelectedHeader(null);
      setSelectedQueueRecordId(null);
      selection.setSelectedId(workerId);
    },
    [selection],
  );
  const selectHeader = useCallback((key: string) => {
    setSelectedHeader(key);
    setSelectedQueueRecordId(null);
  }, []);
  const selectQueueItem = useCallback((recordId: string) => {
    setSelectedHeader(null);
    setSelectedQueueRecordId(recordId);
  }, []);

  const moveBy = useCallback(
    (delta: 1 | -1) => {
      if (visibleRows.length === 0) return;
      const start = currentRowIndex < 0 ? (delta > 0 ? -1 : visibleRows.length) : currentRowIndex;
      const next = (start + delta + visibleRows.length) % visibleRows.length;
      const row = visibleRows[next];
      if (row === undefined) return;
      if (row.kind === 'header') {
        selectHeader(row.group.projectPath);
      } else if (row.kind === 'worker') {
        selectWorker(row.worker.id);
      } else if (row.kind === 'queue-header') {
        selectHeader(QUEUE_KEY);
      } else {
        selectQueueItem(row.pending.recordId);
      }
    },
    [visibleRows, currentRowIndex, selectHeader, selectWorker, selectQueueItem],
  );

  const toggleCurrentHeader = useCallback(() => {
    if (selectedHeader === null) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(selectedHeader)) next.delete(selectedHeader);
      else next.add(selectedHeader);
      return next;
    });
  }, [selectedHeader]);

  // Audit M1 (3c): the kill RPC is fire-and-forget. If the panel
  // unmounts (Tab away during 5s shutdown grace, panel swap in 3F)
  // while the call is in-flight, the resolved promise must not call
  // `setKillNotice` on a dead component. Mirrors the `cancelled` flag
  // pattern used by `useWorkers`.
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const killSelected = useCallback(() => {
    if (selection.selectedId === null) return;
    // Phase 3L: only fire on worker rows. With render-time mutex (no
    // longer clearing selection.selectedId when navigating away from
    // worker rows), the underlying selectedId can linger while
    // selectedHeader / selectedQueueRecordId points elsewhere. K on a
    // queue row must not kill the previously-selected worker.
    if (selectedHeader !== null || selectedQueueRecordId !== null) return;
    const id = selection.selectedId;
    rpc.call.workers
      .kill({ workerId: id })
      .then((result) => {
        if (unmountedRef.current) return;
        if (result.killed) {
          setKillNotice(`killed ${id}`);
        } else {
          setKillNotice(`already terminal: ${result.reason ?? 'unknown'}`);
        }
        workersResult.refresh();
      })
      .catch((err: unknown) => {
        if (unmountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setKillNotice(`kill failed: ${msg}`);
      });
  }, [rpc, selection.selectedId, selectedHeader, selectedQueueRecordId, workersResult]);

  // Phase 3L — find the currently-selected queue entry (if any), for
  // both cancel and reorder. Returns null when no queue row is selected.
  const selectedPending = useMemo<PendingSpawnSnapshot | null>(() => {
    if (selectedQueueRecordId === null) return null;
    return queue.pending.find((p) => p.recordId === selectedQueueRecordId) ?? null;
  }, [selectedQueueRecordId, queue.pending]);

  const cancelSelectedQueued = useCallback(() => {
    if (selectedPending === null) return;
    const intent = selectedPending.featureIntent;
    const recordId = selectedPending.recordId;
    rpc.call.queue
      .cancel({ recordId })
      .then((result) => {
        if (unmountedRef.current) return;
        if (result.cancelled) {
          showToast(`cancelled queued: ${intent}`, { tone: 'success' });
        } else {
          showToast(`cancel failed: ${result.reason ?? 'unknown'}`, { tone: 'warning' });
        }
        queue.refresh();
      })
      .catch((err: unknown) => {
        if (unmountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        showToast(`cancel failed: ${msg}`, { tone: 'error' });
      });
  }, [rpc, selectedPending, showToast, queue]);

  const reorderSelectedQueued = useCallback(
    (direction: 'up' | 'down') => {
      if (selectedPending === null) return;
      const recordId = selectedPending.recordId;
      rpc.call.queue
        .reorder({ recordId, direction })
        .then((result) => {
          if (unmountedRef.current) return;
          if (!result.moved) {
            if (result.reason === 'no neighbor') {
              showToast(
                direction === 'up' ? 'first in project queue' : 'last in project queue',
                { tone: 'info' },
              );
            } else {
              showToast(`reorder failed: ${result.reason ?? 'unknown'}`, { tone: 'warning' });
            }
          }
          queue.refresh();
        })
        .catch((err: unknown) => {
          if (unmountedRef.current) return;
          const msg = err instanceof Error ? err.message : String(err);
          showToast(`reorder failed: ${msg}`, { tone: 'error' });
        });
    },
    [rpc, selectedPending, showToast, queue],
  );

  const ordinalSelect = useCallback(
    (n: number) => {
      selection.selectByOrdinal(visibleWorkerIds, n);
      setSelectedHeader(null);
    },
    [selection, visibleWorkerIds],
  );

  const commands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'workers.next',
        title: 'next',
        key: { kind: 'char', char: 'j' },
        scope: SCOPE,
        displayOnScreen: true,
        onSelect: () => moveBy(1),
      },
      {
        id: 'workers.next.arrow',
        title: 'next',
        key: { kind: 'downArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        onSelect: () => moveBy(1),
      },
      {
        id: 'workers.prev',
        title: 'prev',
        key: { kind: 'char', char: 'k' },
        scope: SCOPE,
        displayOnScreen: true,
        onSelect: () => moveBy(-1),
      },
      {
        id: 'workers.prev.arrow',
        title: 'prev',
        key: { kind: 'upArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        onSelect: () => moveBy(-1),
      },
      {
        id: 'workers.toggleCollapse',
        title: 'collapse',
        key: { kind: 'return' },
        scope: SCOPE,
        displayOnScreen: true,
        onSelect: toggleCurrentHeader,
      },
      {
        id: 'workers.kill',
        title: 'kill',
        key: { kind: 'char', char: 'K' },
        scope: SCOPE,
        displayOnScreen: true,
        onSelect: killSelected,
      },
      {
        id: 'workers.restart',
        title: 'restart',
        key: { kind: 'char', char: 'R' },
        scope: SCOPE,
        displayOnScreen: true,
        onSelect: () => undefined,
        disabledReason: 'Maestro-only — Phase 4',
      },
      {
        id: 'workers.pause',
        title: 'pause',
        key: { kind: 'char', char: 'P' },
        scope: SCOPE,
        displayOnScreen: true,
        onSelect: () => undefined,
        disabledReason: 'no pause primitive yet',
      },
      // Phase 3L — queue commands. `X` cancels the selected queued
      // task; `[` / `]` reorder it up / down within its project.
      //
      // Bracket keys chosen over `Ctrl+J` / `Ctrl+K` because legacy
      // (non-kitty) terminals encode Ctrl+J identically to Enter
      // (both are ASCII LF `\x0a`); the keybind dispatcher can't
      // disambiguate them. Brackets work in every terminal AND are
      // mnemonically "outdent / indent" which matches the reorder
      // intent visually.
      //
      // Bar advertisement is dynamic: visible+enabled only when a
      // queue row is the cursor target (`disabledReason` flips
      // otherwise so the bar still hints at the action).
      {
        id: 'queue.cancel',
        title: 'cancel',
        key: { kind: 'char', char: 'X' },
        scope: SCOPE,
        displayOnScreen: selectedPending !== null,
        onSelect: cancelSelectedQueued,
        ...(selectedPending === null
          ? { disabledReason: 'select a queued task first' }
          : {}),
      },
      {
        id: 'queue.reorder.up',
        title: 'move up',
        key: { kind: 'char', char: '[' },
        scope: SCOPE,
        displayOnScreen: selectedPending !== null,
        onSelect: () => reorderSelectedQueued('up'),
        ...(selectedPending === null
          ? { disabledReason: 'select a queued task first' }
          : {}),
      },
      {
        id: 'queue.reorder.down',
        title: 'move down',
        key: { kind: 'char', char: ']' },
        scope: SCOPE,
        displayOnScreen: selectedPending !== null,
        onSelect: () => reorderSelectedQueued('down'),
        ...(selectedPending === null
          ? { disabledReason: 'select a queued task first' }
          : {}),
      },
      ...buildOrdinalCommands(ordinalSelect),
    ],
    [
      moveBy,
      toggleCurrentHeader,
      killSelected,
      ordinalSelect,
      selectedPending,
      cancelSelectedQueued,
      reorderSelectedQueued,
    ],
  );

  // Phase 3H.4 — apply user keybind overrides before registering. The
  // helper is identity-preserving when no override matches a panel
  // command id, so users with a default config see no extra render
  // churn here. Internal commands are skipped by the helper itself.
  const { config } = useConfig();
  const overriddenCommands = useMemo(
    () => applyKeybindOverrides(commands, config.keybindOverrides),
    [commands, config.keybindOverrides],
  );
  useRegisterCommands(overriddenCommands, isFocused);

  // Drives runtime label refresh once per second. The frame value is
  // unused, but the subscription is the point — re-render at 1 Hz so
  // `formatRuntime(createdAt, Date.now())` produces fresh strings.
  const { frame: secondsTick } = useAnimation({ interval: 1000 });
  const nowMs = useMemo(() => {
    void secondsTick;
    return Date.now();
  }, [secondsTick]);

  // `widthBudget` is the TRUNCATION cap for feature intent — it does
  // NOT represent measured panel width. The bar (5) + space (1) +
  // stage label (12) + space (1) added in Phase 3I consume real row
  // width but don't constrain the intent's truncation length, since
  // the row's `<Box flexGrow={1}/>` absorbs any overflow at the
  // model/runtime gap. Keep the cap unchanged so wide-panel users
  // still see the full 30-char intent.
  const widthBudget = 60;
  const featureIntentBudget = Math.max(12, widthBudget - 30);

  return (
    <Panel focusKey={SCOPE} title="Workers" flexGrow={1}>
      {error !== null ? (
        <Text color={theme['error']}>workers.list failed: {error.message}</Text>
      ) : null}
      {queue.error !== null ? (
        <Text color={theme['error']}>queue.list failed: {queue.error.message}</Text>
      ) : null}
      {visibleRows.length === 0 ? (
        <Text color={theme['textMuted']} dimColor>
          no workers — Maestro will populate this when it spawns one
        </Text>
      ) : (
        <Box flexDirection="column">
          {visibleRows.map((row) => {
            if (row.kind === 'header') {
              const activeCount = row.group.workers.filter(isActive).length;
              return (
                <ProjectGroupHeader
                  key={`h:${row.group.projectPath}`}
                  group={row.group}
                  collapsed={collapsed.has(row.group.projectPath)}
                  selected={selectedHeader === row.group.projectPath}
                  activeCount={activeCount}
                />
              );
            }
            if (row.kind === 'queue-header') {
              return (
                <QueueHeader
                  key="q:header"
                  count={row.count}
                  collapsed={queueCollapsed}
                  selected={isQueueHeaderSelected}
                />
              );
            }
            if (row.kind === 'queue-item') {
              const isSelected = selectedQueueRecordId === row.pending.recordId;
              const featureIntentDisplay = truncate(
                row.pending.featureIntent || row.pending.taskDescription,
                FEATURE_INTENT_BUDGET,
              );
              const projectDisplayName = deriveDisplayName(row.pending.projectPath);
              return (
                <QueueRow
                  key={`q:${row.pending.recordId}`}
                  ordinal={row.ordinal}
                  featureIntentDisplay={featureIntentDisplay}
                  projectDisplayName={projectDisplayName}
                  selected={isSelected}
                />
              );
            }
            const isSelected =
              selectedHeader === null &&
              selectedQueueRecordId === null &&
              selection.selectedId === row.worker.id;
            const instrument = instruments.get(row.worker.id) ?? row.worker.id.slice(0, 8);
            const featureIntentDisplay = truncate(
              row.worker.featureIntent || row.worker.taskDescription,
              featureIntentBudget,
            );
            const runtimeDisplay = formatRuntime(row.worker.createdAt, nowMs);
            return (
              <WorkerRow
                key={`w:${row.worker.id}`}
                worker={row.worker}
                instrument={instrument}
                selected={isSelected}
                featureIntentDisplay={featureIntentDisplay}
                runtimeDisplay={runtimeDisplay}
              />
            );
          })}
        </Box>
      )}
      {killNotice !== null ? (
        <Text color={theme['warning']}>{killNotice}</Text>
      ) : null}
    </Panel>
  );
}

function isActive(w: WorkerRecordSnapshot): boolean {
  return w.status === 'spawning' || w.status === 'running';
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  return `${text.slice(0, max - 1)}…`;
}

function buildOrdinalCommands(
  selectByOrdinal: (n: number) => void,
): readonly Command[] {
  const out: Command[] = [];
  for (let n = 1; n <= 9; n += 1) {
    const ordinal = n;
    out.push({
      id: `workers.select.${ordinal}`,
      title: `#${ordinal}`,
      key: { kind: 'char', char: String(ordinal) },
      scope: SCOPE,
      displayOnScreen: false,
      onSelect: () => selectByOrdinal(ordinal),
    });
  }
  return out;
}
