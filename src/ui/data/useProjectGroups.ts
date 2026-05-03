import { useMemo } from 'react';
import type { WorkerRecordSnapshot } from '../../orchestrator/worker-registry.js';

export interface ProjectGroup {
  /** Group key — `projectPath` so the grouping survives rename. */
  readonly projectPath: string;
  /** Display name — last path segment, or `(unregistered)` for empty. */
  readonly displayName: string;
  /** Workers in this group, sorted by `createdAt` ascending. */
  readonly workers: readonly WorkerRecordSnapshot[];
}

const UNREGISTERED = '(unregistered)';

function deriveDisplayName(projectPath: string): string {
  if (projectPath === '' || projectPath === UNREGISTERED) return UNREGISTERED;
  const trimmed = projectPath.replace(/[\\/]+$/, '');
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed;
}

/**
 * Group workers by `projectPath`. Output is alphabetized by display
 * name with `(unregistered)` always last. Within each group, workers
 * sort by `createdAt` ascending so the oldest worker is at the top of
 * its bucket — matches a "history reads top-to-bottom" reading model.
 *
 * Pure helper exported for direct unit testing; the hook below wraps
 * it in `useMemo` so React renders amortize the work.
 */
export function buildProjectGroups(
  workers: readonly WorkerRecordSnapshot[],
): readonly ProjectGroup[] {
  const buckets = new Map<string, WorkerRecordSnapshot[]>();
  for (const w of workers) {
    const key = w.projectPath === '' ? UNREGISTERED : w.projectPath;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [w]);
    else bucket.push(w);
  }
  const groups: ProjectGroup[] = [];
  for (const [projectPath, ws] of buckets) {
    const sorted = ws.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    groups.push({
      projectPath,
      displayName: deriveDisplayName(projectPath),
      workers: sorted,
    });
  }
  groups.sort((a, b) => {
    const aIsUnreg = a.displayName === UNREGISTERED;
    const bIsUnreg = b.displayName === UNREGISTERED;
    if (aIsUnreg !== bIsUnreg) return aIsUnreg ? 1 : -1;
    return a.displayName.localeCompare(b.displayName);
  });
  return groups;
}

export function useProjectGroups(
  workers: readonly WorkerRecordSnapshot[],
): readonly ProjectGroup[] {
  return useMemo(() => buildProjectGroups(workers), [workers]);
}
