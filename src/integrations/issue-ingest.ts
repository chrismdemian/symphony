import type { ProjectStore } from '../projects/types.js';
import type { ExternalLinkStore } from '../state/external-link-store.js';
import type { TaskStore } from '../state/types.js';
import type { NormalizedIssue } from './issue-connector.js';

/**
 * Phase 8C — the shared "issue candidate → Symphony task" reducer used by the
 * generic `sync_issues` tool for EVERY connector (Linear, GitHub, …). It is the
 * issue-tracker twin of `ingestObsidianCandidates` (8B) and the inlined loop in
 * `sync-notion.ts` (8A): one place owns the terminal-skip + dedup +
 * project-routing + create + link sequence.
 *
 * It never throws on a per-candidate failure — failures accumulate in `errors`
 * so one bad issue can't abort a whole sync batch.
 */

export interface IssueIngestDeps {
  readonly taskStore: TaskStore;
  readonly projectStore: ProjectStore;
  readonly externalLinkStore: ExternalLinkStore;
  /**
   * Resolves a project name/path to an absolute path through the active-
   * project cursor + boot default (mirrors `create_task`). Final fallback when
   * a candidate's `projectValue` matches nothing.
   */
  readonly resolveProjectPath?: (project?: string) => string;
}

export interface IssueIngestResult {
  readonly created: string[];
  readonly skippedExisting: number;
  readonly skippedDone: number;
  readonly skippedNoProject: number;
  readonly errors: string[];
}

/**
 * Ingest a batch of normalized issues for `source` (`'linear'`, `'github'`, …).
 * `projectArg` is the explicit fallback project (the `sync_* project:` arg);
 * omit it to rely on each issue's `projectValue` + the active-project cursor.
 */
export function ingestIssueCandidates(
  candidates: readonly NormalizedIssue[],
  deps: IssueIngestDeps,
  source: string,
  projectArg?: string,
): IssueIngestResult {
  const created: string[] = [];
  let skippedExisting = 0;
  let skippedDone = 0;
  let skippedNoProject = 0;
  const errors: string[] = [];

  for (const candidate of candidates) {
    // Don't import issues already closed/done in the source.
    if (candidate.isTerminal) {
      skippedDone += 1;
      continue;
    }
    // Dedup: an issue already linked to a Symphony task is skipped (idempotent re-sync).
    if (deps.externalLinkStore.getByExternal(source, candidate.externalId)) {
      skippedExisting += 1;
      continue;
    }
    const projectId = resolveProjectId(deps, candidate.projectValue, projectArg);
    if (projectId === undefined) {
      skippedNoProject += 1;
      errors.push(
        `Issue "${truncate(candidate.title, 40)}": could not route to a project ` +
          `(source project: ${candidate.projectValue ?? 'none'}). Pass project:<name> or set_active_project first.`,
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
        source,
        externalId: candidate.externalId,
        ...(candidate.url !== null && candidate.url.length > 0 ? { url: candidate.url } : {}),
      });
      created.push(task.id);
    } catch (err) {
      errors.push(
        `Issue "${truncate(candidate.title, 40)}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { created, skippedExisting, skippedDone, skippedNoProject, errors };
}

/**
 * Resolve a candidate to a Symphony project id:
 *   1. the issue's own `projectValue`, if it matches a registered project name/id;
 *   2. the explicit `projectArg`;
 *   3. the active-project cursor / boot default (via `resolveProjectPath`).
 * Returns `undefined` when nothing resolves.
 *
 * The server `resolveProjectPath` THROWS for an unknown non-absolute name — the
 * try/catch routes ONE bad `project:` arg to `skippedNoProject` instead of
 * aborting the whole sync (8A audit-M2; regression-locked).
 */
function resolveProjectId(
  deps: IssueIngestDeps,
  candidateProject: string | null,
  projectArg: string | undefined,
): string | undefined {
  if (candidateProject !== null) {
    const matched = deps.projectStore.get(candidateProject);
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
