import path from 'node:path';
import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import {
  toWaveSnapshot,
  type WaveStore,
} from '../research-wave-registry.js';
import type { ToolRegistration } from '../registry.js';
import type { WorkerLifecycleHandle, SpawnWorkerInput } from '../worker-lifecycle.js';
import { toSnapshot, type WorkerRegistry } from '../worker-registry.js';

/**
 * Upper bound from PLAN.md rule #12 — "fire off the 7th agent". Lower
 * bound is 2 because `n=1` is degenerate (use `spawn_worker` directly).
 */
export const RESEARCH_WAVE_MIN = 2;
export const RESEARCH_WAVE_MAX = 7;

const shape = {
  topic: z
    .string()
    .min(1)
    .describe('Shared research topic. Each worker receives this plus an optional per-worker sub-topic from agenda.'),
  n: z
    .number()
    .int()
    .min(RESEARCH_WAVE_MIN)
    .max(RESEARCH_WAVE_MAX)
    .describe(`Number of researcher workers to spawn in parallel. ${RESEARCH_WAVE_MIN}..${RESEARCH_WAVE_MAX}.`),
  project: z
    .string()
    .optional()
    .describe('Project key (name or absolute path). Omit to use the orchestrator default project.'),
  agenda: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'Optional array of sub-topics, one per worker. Length must equal n. When omitted, all workers share the same topic.',
    ),
  model: z.string().optional().describe('Optional model override applied to every worker in the wave.'),
};

/**
 * Minimal researcher preamble — 2A.4a ships the primitive, Phase 4 will
 * replace with `worker-role-researcher.md` fragment. The preamble stays
 * read-only: no "write tools" — the delegator-never-edits-source
 * architecture (CapabilityEvaluator) enforces this at the MCP layer, and
 * the prompt reinforces it for the worker's self-policing.
 */
const RESEARCHER_PREAMBLE = [
  'You are a Claude Code worker gathering information for an orchestration layer.',
  'You do NOT modify files. Read, grep, search, and report.',
  'Your findings will be aggregated with N-1 other researchers into one report.',
  'Cite file:line or tool-result for every claim. No bare assertions.',
  'End with the 8-field structured completion JSON (did/skipped/blockers/open_questions/audit/cite/tests_run/preview_url).',
  '',
].join('\n');

export interface ResearchWaveDeps {
  readonly registry: WorkerRegistry;
  readonly lifecycle: WorkerLifecycleHandle;
  readonly waveStore: WaveStore;
  readonly projectStore: ProjectStore;
  readonly resolveProjectPath: (project?: string) => string;
}

function composePrompt(topic: string, subtopic: string | undefined, index: number, n: number): string {
  const assignment = subtopic
    ? `Your sub-topic (${index + 1}/${n}): ${subtopic}\nShared wave topic: ${topic}`
    : `Wave topic (${index + 1}/${n}): ${topic}`;
  return `${RESEARCHER_PREAMBLE}${assignment}\n`;
}

export function makeResearchWaveTool(
  deps: ResearchWaveDeps,
): ToolRegistration<typeof shape> {
  return {
    name: 'research_wave',
    description:
      `Spawn ${RESEARCH_WAVE_MIN}..${RESEARCH_WAVE_MAX} researcher workers in parallel on a shared topic. Returns the wave_id + worker_ids; aggregation is a separate follow-up (read each worker's output via get_worker_output). Researcher role is read-only — the delegator-never-edits-source architecture prevents file writes regardless.`,
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: async ({ topic, n, project, agenda, model }, ctx) => {
      if (agenda !== undefined && agenda.length !== n) {
        return {
          content: [
            {
              type: 'text',
              text: `research_wave: agenda length (${agenda.length}) must equal n (${n}).`,
            },
          ],
          isError: true,
        };
      }

      // Resolve project to BOTH a filesystem path (for spawn) AND a
      // canonical projectId (for WaveStore persistence). Mirrors
      // `ask_user`'s pattern — fix for 2A.4a audit M2. Two named-project
      // semantics the resolution must preserve:
      //   1. Registered names / ids → canonical `proj.id` for the wave.
      //   2. Unregistered absolute paths → acceptable for spawn (Phase 5
      //      groundwork in server.ts:resolveProjectPath), but we do NOT
      //      persist a raw path as `projectId` — leave it undefined so
      //      WaveStore queries don't surface bogus matches.
      let projectPath: string;
      let projectId: string | undefined;
      if (project !== undefined) {
        const proj = deps.projectStore.get(project);
        if (proj) {
          projectPath = proj.path;
          projectId = proj.id;
        } else if (path.isAbsolute(project)) {
          projectPath = path.resolve(project);
          // projectId stays undefined — waves for unregistered paths are
          // findable by workerIds, not by project filter.
        } else {
          return {
            content: [
              { type: 'text', text: `research_wave: Unknown project '${project}'.` },
            ],
            isError: true,
          };
        }
      } else {
        try {
          projectPath = deps.resolveProjectPath(undefined);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text', text: `research_wave: ${msg}` }],
            isError: true,
          };
        }
      }

      const spawnResults = await Promise.allSettled(
        Array.from({ length: n }, (_unused, idx) => {
          const subtopic = agenda?.[idx];
          const input: SpawnWorkerInput = {
            projectPath,
            projectId: projectId ?? null,
            taskDescription: composePrompt(topic, subtopic, idx, n),
            role: 'researcher',
            featureIntent: subtopic
              ? `research-${idx + 1}-${subtopic.slice(0, 40)}`
              : `research-${idx + 1}-${topic.slice(0, 40)}`,
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
            ...(model !== undefined ? { model } : {}),
          };
          return deps.lifecycle.spawn(input);
        }),
      );

      const workerIds: string[] = [];
      const failures: string[] = [];
      const snapshots: Record<string, unknown>[] = [];
      for (const [idx, result] of spawnResults.entries()) {
        if (result.status === 'fulfilled') {
          workerIds.push(result.value.id);
          snapshots.push(toSnapshot(result.value) as unknown as Record<string, unknown>);
        } else {
          const reason = result.reason;
          const msg = reason instanceof Error ? reason.message : String(reason);
          failures.push(`worker ${idx + 1}: ${msg}`);
        }
      }

      if (workerIds.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `research_wave: all ${n} spawns failed.\n- ${failures.join('\n- ')}`,
            },
          ],
          isError: true,
        };
      }

      // Post-fan-out abort rollback (audit 2A.4a M3). `ctx.signal` is
      // forwarded into every spawn above, but if the signal fires between
      // a successful spawn resolving and the remaining ones aborting,
      // we land with orphaned workers (subprocess + worktree + registry
      // entry) that Maestro never hears about — dispatch has already
      // aborted. Kill every successful spawn and return isError so no
      // wave record lingers. Worktree cleanup is best-effort; Phase 1D's
      // orphan sweep and 2A.4b's finalize own the on-disk cleanup path.
      if (ctx.signal?.aborted) {
        for (const id of workerIds) {
          const rec = deps.registry.get(id);
          if (rec) {
            try {
              rec.worker.kill('SIGTERM');
            } catch {
              /* best effort */
            }
            deps.lifecycle.cleanup(id);
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: `research_wave: dispatch aborted after ${workerIds.length} successful spawn(s); rolled back.`,
            },
          ],
          isError: true,
        };
      }

      const wave = deps.waveStore.enqueue({
        topic,
        workerIds,
        ...(projectId !== undefined ? { projectId } : {}),
      });
      const waveSnap = toWaveSnapshot(wave);

      const summary = [
        `Wave ${waveSnap.id} launched: ${workerIds.length}/${n} researchers spawned on "${topic}".`,
        ...workerIds.map((id) => `- ${id}`),
        ...(failures.length > 0 ? ['', `${failures.length} spawn(s) failed:`, ...failures.map((f) => `- ${f}`)] : []),
      ].join('\n');

      return {
        content: [{ type: 'text', text: summary }],
        structuredContent: {
          wave: waveSnap as unknown as Record<string, unknown>,
          workers: snapshots,
          spawned: workerIds.length,
          requested: n,
          ...(failures.length > 0 ? { failures } : {}),
        },
      };
    },
  };
}
