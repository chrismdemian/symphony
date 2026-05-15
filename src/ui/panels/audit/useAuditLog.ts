/**
 * Phase 3R — `/log` data hook.
 *
 * Owns the filter text + parsed filter, resolves `--project <name>` to
 * an id against `projects.list`, and polls `audit.list` on a 2s cadence
 * with the race-safe `inFlightRef` + `pendingRefreshRef` pattern
 * (3L `useQueue` / 3P `DepsPanel` precedent).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TuiRpc } from '../../runtime/rpc.js';
import type { AuditEntry } from '../../../state/audit-store.js';
import type { ProjectSnapshot } from '../../../projects/types.js';
import { parseLogFilter, type ParsedLogFilter } from './parseFilters.js';

export interface UseAuditLogResult {
  readonly entries: readonly AuditEntry[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly filterText: string;
  readonly parseErrors: readonly string[];
  /** True when `--project <name>` named an unregistered project. */
  readonly unknownProject: string | null;
  setFilterText(next: string): void;
  appendFilterChar(ch: string): void;
  backspaceFilter(): void;
  clearFilter(): void;
  refresh(): void;
}

const POLL_MS = 2_000;

export function useAuditLog(rpc: TuiRpc, isFocused: boolean): UseAuditLogResult {
  const [filterText, setFilterTextState] = useState('');
  const [entries, setEntries] = useState<readonly AuditEntry[]>([]);
  const [projects, setProjects] = useState<readonly ProjectSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const inFlightRef = useRef(false);
  const pendingRefreshRef = useRef(false);

  const parsed: ParsedLogFilter = useMemo(
    () => parseLogFilter(filterText, Date.now()),
    // Re-parse only when the text changes; `Date.now()` drift between
    // keystrokes is sub-second and irrelevant for an audit window.
    [filterText],
  );

  const resolvedProjectId = useMemo<{ id?: string; unknown: string | null }>(() => {
    if (parsed.projectName === undefined) return { unknown: null };
    const needle = parsed.projectName.trim().toLowerCase();
    const hit = projects.find((p) => p.name.toLowerCase() === needle);
    if (hit !== undefined) return { id: hit.id, unknown: null };
    return { unknown: parsed.projectName };
  }, [parsed.projectName, projects]);

  useEffect(() => {
    if (!isFocused) return;
    const handle = setInterval(() => setTick((n) => n + 1), POLL_MS);
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
        const args: Record<string, unknown> = {};
        if (resolvedProjectId.id !== undefined) args['projectId'] = resolvedProjectId.id;
        if (parsed.kinds !== undefined) args['kinds'] = parsed.kinds;
        if (parsed.severity !== undefined) args['severity'] = parsed.severity;
        if (parsed.workerId !== undefined) args['workerId'] = parsed.workerId;
        if (parsed.sinceTs !== undefined) args['sinceTs'] = parsed.sinceTs;
        if (parsed.limit !== undefined) args['limit'] = parsed.limit;
        const [list, projectList] = await Promise.all([
          // If the user named an unknown project, short-circuit to an
          // empty result rather than listing everything (the filter the
          // user typed clearly intended a subset).
          resolvedProjectId.unknown !== null
            ? Promise.resolve([] as AuditEntry[])
            : rpc.call.audit.list(args),
          rpc.call.projects.list(),
        ]);
        if (cancelled) return;
        setEntries(list);
        setProjects(projectList);
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
  }, [
    rpc,
    tick,
    resolvedProjectId.id,
    resolvedProjectId.unknown,
    parsed.kinds,
    parsed.severity,
    parsed.workerId,
    parsed.sinceTs,
    parsed.limit,
  ]);

  const setFilterText = useCallback((next: string) => {
    setFilterTextState(next);
  }, []);
  const appendFilterChar = useCallback((ch: string) => {
    setFilterTextState((prev) => prev + ch);
  }, []);
  const backspaceFilter = useCallback(() => {
    setFilterTextState((prev) => prev.slice(0, -1));
  }, []);
  const clearFilter = useCallback(() => {
    setFilterTextState('');
  }, []);
  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  return {
    entries,
    loading,
    error,
    filterText,
    parseErrors: parsed.errors,
    unknownProject: resolvedProjectId.unknown,
    setFilterText,
    appendFilterChar,
    backspaceFilter,
    clearFilter,
    refresh,
  };
}
