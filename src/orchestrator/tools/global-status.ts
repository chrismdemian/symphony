import path from 'node:path';
import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type { WorktreeManager } from '../../worktree/manager.js';
import type { ToolRegistration } from '../registry.js';
import { toSnapshot, type WorkerRegistry } from '../worker-registry.js';

const shape = {
  uncommitted: z
    .boolean()
    .optional()
    .describe('Include per-worker uncommitted-change summary (extra git spawn per worker). Default false.'),
};

export interface GlobalStatusDeps {
  readonly projectStore: ProjectStore;
  readonly workerRegistry: WorkerRegistry;
  readonly worktreeManager: WorktreeManager;
}

interface UncommittedSummary {
  readonly worker_id: string;
  readonly has_changes: boolean;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
}

export function makeGlobalStatusTool(
  deps: GlobalStatusDeps,
): ToolRegistration<typeof shape> {
  return {
    name: 'global_status',
    description:
      'Snapshot across all projects and workers — answers "where was I?". Returns per-project counts (active / completed / failed), last activity timestamps, and optionally uncommitted change summaries per worker.',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: async ({ uncommitted }, ctx) => {
      const projects = deps.projectStore.snapshots();
      const workers = deps.workerRegistry.snapshots();

      interface Bucket {
        projectName: string;
        projectPath: string;
        total: number;
        active: number;
        completed: number;
        failed: number;
        lastEventAt?: string;
      }
      const buckets = new Map<string, Bucket>();

      const bucketKey = (p: string): string => path.resolve(p);

      for (const p of projects) {
        const key = bucketKey(p.path);
        buckets.set(key, {
          projectName: p.name,
          projectPath: p.path,
          total: 0,
          active: 0,
          completed: 0,
          failed: 0,
        });
      }

      for (const w of workers) {
        const wkey = bucketKey(w.projectPath);
        const known = buckets.get(wkey);
        const bucket =
          known ??
          (() => {
            // Unregistered project (bare absolute-path usage). Synthesize
            // a row so counts are never silently lost.
            const fresh: Bucket = {
              projectName: '(unregistered)',
              projectPath: w.projectPath,
              total: 0,
              active: 0,
              completed: 0,
              failed: 0,
            };
            buckets.set(wkey, fresh);
            return fresh;
          })();
        bucket.total += 1;
        if (w.status === 'spawning' || w.status === 'running') bucket.active += 1;
        else if (w.status === 'completed') bucket.completed += 1;
        else if (
          w.status === 'failed' ||
          w.status === 'crashed' ||
          w.status === 'timeout' ||
          w.status === 'killed'
        ) {
          bucket.failed += 1;
        }
        if (w.lastEventAt !== undefined) {
          if (bucket.lastEventAt === undefined || w.lastEventAt > bucket.lastEventAt) {
            bucket.lastEventAt = w.lastEventAt;
          }
        }
      }

      const uncommittedSummaries: UncommittedSummary[] = [];
      if (uncommitted === true) {
        const activeWorkers = workers.filter(
          (w) => w.status === 'spawning' || w.status === 'running' || w.status === 'completed',
        );
        const statuses = await Promise.allSettled(
          activeWorkers.map(async (w) => {
            if (ctx.signal?.aborted) throw new Error('global_status aborted');
            const st = await deps.worktreeManager.status(w.worktreePath);
            return {
              worker_id: w.id,
              has_changes: st.hasChanges,
              staged: st.staged.length,
              unstaged: st.unstaged.length,
              untracked: st.untracked.length,
            };
          }),
        );
        for (const r of statuses) {
          if (r.status === 'fulfilled') uncommittedSummaries.push(r.value);
        }
      }

      const activeTotal = workers.filter(
        (w) => w.status === 'spawning' || w.status === 'running',
      ).length;

      const rows = Array.from(buckets.values()).sort((a, b) => a.projectName.localeCompare(b.projectName));
      const text = [
        `${workers.length} worker(s) across ${buckets.size} project(s); ${activeTotal} active.`,
        ...rows.map(
          (b) =>
            `- ${b.projectName}: ${b.active} active / ${b.completed} done / ${b.failed} failed` +
            (b.lastEventAt ? ` · last ${b.lastEventAt}` : ''),
        ),
      ].join('\n');

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          totals: {
            projects: buckets.size,
            workers: workers.length,
            active: activeTotal,
          },
          projects: rows.map((b) => ({
            project: b.projectName,
            path: b.projectPath,
            total: b.total,
            active: b.active,
            completed: b.completed,
            failed: b.failed,
            ...(b.lastEventAt !== undefined ? { last_event_at: b.lastEventAt } : {}),
          })),
          workers: workers.map((w) => toSnapshot(deps.workerRegistry.get(w.id)!)) as unknown as Record<
            string,
            unknown
          >[],
          ...(uncommitted === true ? { uncommitted: uncommittedSummaries } : {}),
        },
      };
    },
  };
}
