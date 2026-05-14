import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import { useFocus } from '../../focus/focus.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import type { TuiRpc } from '../../runtime/rpc.js';
import type {
  TaskGraph,
} from '../../../orchestrator/task-deps.js';
import { groupEdgesByFrom } from '../../../orchestrator/task-deps.js';
import type { ProjectSnapshot } from '../../../projects/types.js';
import type { TaskSnapshot, TaskStatus } from '../../../state/types.js';

/**
 * Phase 3P — `/deps` popup. Renders the task dep graph from
 * `tasks.graph()`. Per Chris's PLAN choice, the panel shows GRAPH-ONLY
 * nodes (tasks with at least one edge — incoming or outgoing); solo
 * tasks are hidden (the 3L Queue panel covers those).
 *
 * Layout:
 *   - Header: title + loading hint
 *   - (optional) cycle banner in red if `cycles.length > 0`
 *   - Nodes grouped by project. Each node row shows: status glyph,
 *     short id, description, and inline `depends on: …` list.
 *
 * Polled at 2s (same cadence as StatsPanel). Unmount on close stops
 * the interval.
 *
 * Hand-built; matches the StatsPanel shape so the chrome looks
 * consistent across popups.
 */

const SCOPE = 'deps';
const SHORT_DESC_MAX = 56;

export interface DepsPanelProps {
  readonly rpc: TuiRpc;
}

interface DepsData {
  readonly graph: TaskGraph;
  readonly projects: readonly ProjectSnapshot[];
}

const EMPTY_DATA: DepsData = {
  graph: { nodes: [], edges: [], cycles: [] },
  projects: [],
};

interface StatusGlyph {
  readonly glyph: string;
  readonly tone: 'success' | 'accent' | 'warning' | 'error' | 'muted';
}

/**
 * Status glyph + tone mapping. Aligns with StatsPanel + Bubble + StatusDot:
 *   - completed → ✓ success/gold
 *   - in_progress → ● accent/violet (live)
 *   - pending → ◷ muted/gray (waiting) OR violet (when this node is
 *     READY — pure-blocked vs. ready-to-claim is the most useful
 *     distinction for the graph view)
 *   - failed → ✗ error/red
 *   - cancelled → ⊘ muted/gray
 */
function statusGlyphFor(
  status: TaskStatus,
  isReady: boolean,
): StatusGlyph {
  switch (status) {
    case 'completed':
      return { glyph: '✓', tone: 'success' };
    case 'in_progress':
      return { glyph: '●', tone: 'accent' };
    case 'pending':
      return isReady
        ? { glyph: '◷', tone: 'accent' }
        : { glyph: '◷', tone: 'muted' };
    case 'failed':
      return { glyph: '✗', tone: 'error' };
    case 'cancelled':
      return { glyph: '⊘', tone: 'muted' };
    default:
      return { glyph: '·', tone: 'muted' };
  }
}

function shortDescription(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SHORT_DESC_MAX) return trimmed;
  return `${trimmed.slice(0, SHORT_DESC_MAX - 1)}…`;
}

function shortId(id: string): string {
  // `tk-12345678` → `tk-1234` for compact rows; full id still in tooltip-free
  // chrome via the description so the user can identify which task this is.
  if (id.length <= 8) return id;
  return id.slice(0, 8);
}

/**
 * Compute readiness for each node WITHOUT another RPC roundtrip: a
 * pending node is "ready" iff every entry in its `dependsOn` resolves
 * to a node in the FULL graph whose status is `'completed'`. The graph
 * server-side already filters nodes to "has at least one edge", so we
 * cross-reference deps against the visible-node set augmented with any
 * dep-only targets via the full set lookup.
 *
 * Caller passes both `graph.nodes` (graph-only filter) and the full
 * `nodesById` map built from the same source so unknown dep ids count
 * as "not completed" (default to blocked).
 */
function computeReadyMap(
  nodes: readonly TaskSnapshot[],
): ReadonlyMap<string, boolean> {
  const byId = new Map<string, TaskSnapshot>();
  for (const n of nodes) byId.set(n.id, n);
  const out = new Map<string, boolean>();
  for (const n of nodes) {
    if (n.status !== 'pending') {
      out.set(n.id, false);
      continue;
    }
    let ready = true;
    for (const depId of n.dependsOn) {
      const dep = byId.get(depId);
      if (dep === undefined || dep.status !== 'completed') {
        ready = false;
        break;
      }
    }
    out.set(n.id, ready);
  }
  return out;
}

export function DepsPanel({ rpc }: DepsPanelProps): React.JSX.Element {
  const theme = useTheme();
  const focus = useFocus();
  const isFocused = focus.currentScope === SCOPE;
  const popPopup = focus.popPopup;
  const [data, setData] = useState<DepsData>(EMPTY_DATA);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState<number>(0);
  const inFlightRef = useRef(false);
  const pendingRefreshRef = useRef(false);

  // 2s poll cadence (same as StatsPanel).
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
        const [graph, projects] = await Promise.all([
          rpc.call.tasks.graph(),
          rpc.call.projects.list(),
        ]);
        if (cancelled) return;
        setData({ graph, projects });
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
        id: 'deps.dismiss',
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

  const readyMap = useMemo(() => computeReadyMap(data.graph.nodes), [data.graph.nodes]);
  const projectName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of data.projects) m.set(p.id, p.name);
    return (id: string): string => m.get(id) ?? '(unknown)';
  }, [data.projects]);
  const edgesByFrom = useMemo(
    () => groupEdgesByFrom(data.graph.edges),
    [data.graph.edges],
  );

  // Group nodes by projectId, preserving input order.
  const grouped = useMemo(() => {
    const order: string[] = [];
    const byProject = new Map<string, TaskSnapshot[]>();
    for (const n of data.graph.nodes) {
      const list = byProject.get(n.projectId);
      if (list === undefined) {
        byProject.set(n.projectId, [n]);
        order.push(n.projectId);
      } else {
        list.push(n);
      }
    }
    return order.map((projectId) => ({
      projectId,
      projectName: projectName(projectId),
      nodes: byProject.get(projectId) ?? [],
    }));
  }, [data.graph.nodes, projectName]);

  const toneColor = (tone: StatusGlyph['tone']): string => {
    switch (tone) {
      case 'success':
        return theme['success']!;
      case 'accent':
        return theme['accent']!;
      case 'warning':
        return theme['warning']!;
      case 'error':
        return theme['error']!;
      case 'muted':
      default:
        return theme['textMuted']!;
    }
  };

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
          Task dependencies
        </Text>
        {loading && (
          <Text color={theme['textMuted']}> · loading</Text>
        )}
      </Box>

      {error !== null && (
        <Box marginBottom={1}>
          <Text color={theme['error']}>Failed to load graph: {error}</Text>
        </Box>
      )}

      {data.graph.cycles.length > 0 && (
        <Box marginBottom={1} flexDirection="column">
          <Text color={theme['error']} bold>
            ⚠ Dependency cycle detected ({data.graph.cycles.length}):
          </Text>
          {data.graph.cycles.map((cycle, i) => (
            <Text key={i} color={theme['error']}>
              {'  '}
              {cycle.map((id) => shortId(id)).join(' → ')}
            </Text>
          ))}
        </Box>
      )}

      {grouped.length === 0 ? (
        <Box marginBottom={1}>
          <Text color={theme['textMuted']}>
            No task dependencies yet. Add deps via `create_task(depends_on=[…])` and they show up here.
          </Text>
        </Box>
      ) : (
        grouped.map(({ projectId, projectName: pname, nodes }) => (
          <Box key={projectId} flexDirection="column" marginBottom={1}>
            <Text color={theme['accent']} bold>
              {pname}
              <Text color={theme['textMuted']}> · {nodes.length}{' '}
                {nodes.length === 1 ? 'task' : 'tasks'}
              </Text>
            </Text>
            {nodes.map((node) => {
              const ready = readyMap.get(node.id) === true;
              const { glyph, tone } = statusGlyphFor(node.status, ready);
              const deps = edgesByFrom.get(node.id) ?? [];
              const depList = deps.map((d) => shortId(d)).join(', ');
              return (
                <Box key={node.id} flexDirection="column">
                  <Box flexDirection="row">
                    <Text color={theme['textMuted']}>{'  '}</Text>
                    <Text color={toneColor(tone)}>{glyph}</Text>
                    <Text color={theme['textMuted']}> {shortId(node.id)} </Text>
                    <Text color={theme['text']}>{shortDescription(node.description)}</Text>
                  </Box>
                  {depList.length > 0 && (
                    <Box flexDirection="row">
                      <Text color={theme['textMuted']}>
                        {'      depends on: '}
                        {depList}
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text color={theme['textMuted']}>Esc to close</Text>
      </Box>
    </Box>
  );
}
