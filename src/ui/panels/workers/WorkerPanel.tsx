import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useAnimation } from 'ink';
import type { WorkerRecordSnapshot } from '../../../orchestrator/worker-registry.js';
import { Panel } from '../../layout/Panel.js';
import { useTheme } from '../../theme/context.js';
import { useFocus } from '../../focus/focus.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import { applyKeybindOverrides } from '../../keybinds/overrides.js';
import { useConfig } from '../../../utils/config-context.js';
import { useProjectGroups, type ProjectGroup } from '../../data/useProjectGroups.js';
import { useInstrumentNames } from '../../data/useInstrumentNames.js';
import { useWorkerSelection } from '../../data/WorkerSelection.js';
import type { TuiRpc } from '../../runtime/rpc.js';
import type { UseWorkersResult } from '../../data/useWorkers.js';
import { ProjectGroupHeader } from './ProjectGroupHeader.js';
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

type VisibleRow =
  | { readonly kind: 'header'; readonly group: ProjectGroup }
  | {
      readonly kind: 'worker';
      readonly group: ProjectGroup;
      readonly worker: WorkerRecordSnapshot;
    };

export interface WorkerPanelProps {
  readonly rpc: TuiRpc;
  readonly workersResult: UseWorkersResult;
}

export function WorkerPanel({ rpc, workersResult }: WorkerPanelProps): React.JSX.Element {
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
  const [killNotice, setKillNotice] = useState<string | null>(null);

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
    return { visibleRows: rows, visibleWorkerIds: ids };
  }, [groups, collapsed]);

  // Reconcile selection when the worker id set changes.
  useEffect(() => {
    selection.reconcile(visibleWorkerIds);
  }, [selection, visibleWorkerIds]);

  // Auto-clear header-selection when the targeted group disappears.
  useEffect(() => {
    if (selectedHeader === null) return;
    if (!groups.some((g) => g.projectPath === selectedHeader)) {
      setSelectedHeader(null);
    }
  }, [selectedHeader, groups]);

  // Auto-clear kill notice after 2s so it doesn't stick around forever.
  useEffect(() => {
    if (killNotice === null) return;
    const handle = setTimeout(() => setKillNotice(null), 2000);
    return () => clearTimeout(handle);
  }, [killNotice]);

  const currentRowIndex = useMemo(() => {
    if (selectedHeader !== null) {
      return visibleRows.findIndex(
        (r) => r.kind === 'header' && r.group.projectPath === selectedHeader,
      );
    }
    if (selection.selectedId !== null) {
      return visibleRows.findIndex(
        (r) => r.kind === 'worker' && r.worker.id === selection.selectedId,
      );
    }
    return -1;
  }, [visibleRows, selectedHeader, selection.selectedId]);

  const moveBy = useCallback(
    (delta: 1 | -1) => {
      if (visibleRows.length === 0) return;
      const start = currentRowIndex < 0 ? (delta > 0 ? -1 : visibleRows.length) : currentRowIndex;
      const next = (start + delta + visibleRows.length) % visibleRows.length;
      const row = visibleRows[next];
      if (row === undefined) return;
      if (row.kind === 'header') {
        setSelectedHeader(row.group.projectPath);
      } else {
        setSelectedHeader(null);
        selection.setSelectedId(row.worker.id);
      }
    },
    [visibleRows, currentRowIndex, selection],
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
  }, [rpc, selection.selectedId, workersResult]);

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
      ...buildOrdinalCommands(ordinalSelect),
    ],
    [moveBy, toggleCurrentHeader, killSelected, ordinalSelect],
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

  const widthBudget = 60;
  const featureIntentBudget = Math.max(12, widthBudget - 30);

  return (
    <Panel focusKey={SCOPE} title="Workers" flexGrow={1}>
      {error !== null ? (
        <Text color={theme['error']}>workers.list failed: {error.message}</Text>
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
            const isSelected =
              selectedHeader === null && selection.selectedId === row.worker.id;
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
