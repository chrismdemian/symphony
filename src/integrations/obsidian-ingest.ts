import type { ProjectStore } from '../projects/types.js';
import type { ExternalLinkStore } from '../state/external-link-store.js';
import { isTerminalStatus, type TaskStore } from '../state/types.js';
import { OBSIDIAN_INTEGRATION } from './obsidian-config.js';
import type { ObsidianTaskCandidate } from './obsidian.js';

/**
 * Phase 8B — the shared "candidate → Symphony task" reducer used by BOTH the
 * `sync_obsidian` MCP tool (bulk on-demand import) and the live vault watcher
 * (per-file ingest on edit). Extracting it keeps the dedup + project-routing +
 * create + link sequence in one place (mirrors `sync-notion`'s loop body).
 *
 * It never throws on a per-candidate failure — failures accumulate in
 * `errors` so one bad task line can't abort a whole batch.
 */

export interface ObsidianIngestDeps {
  readonly taskStore: TaskStore;
  readonly projectStore: ProjectStore;
  readonly externalLinkStore: ExternalLinkStore;
  /**
   * Resolves a project name/path to an absolute path through the active-
   * project cursor + boot default (mirrors `create_task`). Final fallback when
   * a candidate's frontmatter project value matches nothing.
   */
  readonly resolveProjectPath?: (project?: string) => string;
}

export interface ObsidianIngestResult {
  readonly created: string[];
  readonly skippedExisting: number;
  readonly skippedDone: number;
  readonly skippedNoProject: number;
  readonly errors: string[];
}

/**
 * Ingest a batch of candidates. `projectArg` is the explicit fallback project
 * (the `sync_obsidian project:` arg); the watcher passes `undefined` and relies
 * on frontmatter + the active-project cursor.
 */
export function ingestObsidianCandidates(
  candidates: readonly ObsidianTaskCandidate[],
  deps: ObsidianIngestDeps,
  projectArg?: string,
): ObsidianIngestResult {
  const created: string[] = [];
  let skippedExisting = 0;
  let skippedDone = 0;
  let skippedNoProject = 0;
  const errors: string[] = [];

  for (const candidate of candidates) {
    // Defense in depth — the connector already filters terminal tasks.
    if (isTerminalStatus(candidate.status)) {
      skippedDone += 1;
      continue;
    }
    // Dedup: a task line already linked to a Symphony task is skipped.
    if (deps.externalLinkStore.getByExternal(OBSIDIAN_INTEGRATION, candidate.externalId)) {
      skippedExisting += 1;
      continue;
    }
    const projectId = resolveProjectId(deps, candidate.projectValue, projectArg);
    if (projectId === undefined) {
      skippedNoProject += 1;
      errors.push(
        `Task "${truncate(candidate.title, 40)}": could not route to a project ` +
          `(frontmatter project: ${candidate.projectValue ?? 'none'}). Pass project:<name> or set_active_project first.`,
      );
      continue;
    }
    try {
      const task = deps.taskStore.create({
        projectId,
        description: candidate.title,
        priority: candidate.priority,
      });
      deps.externalLinkStore.link({
        taskId: task.id,
        source: OBSIDIAN_INTEGRATION,
        externalId: candidate.externalId,
        ...(candidate.url.length > 0 ? { url: candidate.url } : {}),
      });
      created.push(task.id);
    } catch (err) {
      errors.push(
        `Task "${truncate(candidate.title, 40)}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { created, skippedExisting, skippedDone, skippedNoProject, errors };
}

/**
 * Resolve a candidate to a Symphony project id:
 *   1. the candidate's frontmatter project value, if it matches a registered
 *      project name/id;
 *   2. the explicit `projectArg`;
 *   3. the active-project cursor / boot default (via `resolveProjectPath`).
 * Returns `undefined` when nothing resolves. Mirrors `sync-notion`'s resolver
 * (including swallowing the resolver throw on an unknown non-absolute name).
 */
function resolveProjectId(
  deps: ObsidianIngestDeps,
  frontmatterProject: string | null,
  projectArg: string | undefined,
): string | undefined {
  if (frontmatterProject !== null) {
    const matched = deps.projectStore.get(frontmatterProject);
    if (matched) return matched.id;
  }
  if (projectArg !== undefined) {
    const matched = deps.projectStore.get(projectArg);
    if (matched) return matched.id;
  }
  if (deps.resolveProjectPath !== undefined) {
    let cursorPath: string;
    try {
      cursorPath = deps.resolveProjectPath(projectArg);
    } catch {
      return undefined;
    }
    for (const p of deps.projectStore.list()) {
      if (p.path === cursorPath) return p.id;
    }
  }
  return undefined;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
