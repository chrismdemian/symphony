import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type { ExternalLinkStore } from '../../state/external-link-store.js';
import { isTerminalStatus, type TaskStore } from '../../state/types.js';
import { NOTION_INTEGRATION } from '../../integrations/notion-config.js';
import type { NotionConnectorHandle } from '../../integrations/notion.js';
import type { ToolRegistration } from '../registry.js';

const shape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Max number of Notion pages to pull this sync (default 100, newest-edited first).'),
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Fallback project (name or id) for pages whose Notion project property doesn't match a registered project. When omitted, falls back to the active project / boot default.",
    ),
};

export interface SyncNotionDeps {
  readonly connector: NotionConnectorHandle;
  readonly taskStore: TaskStore;
  readonly projectStore: ProjectStore;
  readonly externalLinkStore: ExternalLinkStore;
  /**
   * Resolves a project name/path to an absolute path through the active-
   * project cursor + boot default (mirrors `create_task`). Used as the
   * final fallback when a page's Notion project value matches nothing.
   */
  readonly resolveProjectPath?: (project?: string) => string;
}

/**
 * Phase 8A — `sync_notion`. Pulls open pages from the configured Notion
 * database and creates a Symphony task per NEW page (deduped by external
 * link, so re-running is idempotent). Pages already in a terminal Notion
 * status are skipped (don't import done work). Notion is the source for
 * task CREATION; Symphony owns status thereafter and pushes terminal
 * statuses back to Notion via the writeback hook (see server.ts).
 */
export function makeSyncNotionTool(deps: SyncNotionDeps): ToolRegistration<typeof shape> {
  return {
    name: 'sync_notion',
    description:
      'Pull open tasks from the configured Notion database into Symphony. Creates one pending task per new Notion page (idempotent — already-imported pages are skipped). Maps title→description, project tag→project routing, priority→priority; skips pages already marked done in Notion. Requires `symphony config notion`.',
    scope: 'both',
    capabilities: [
      'requires-secrets-read',
      'requires-network-egress-uncontrolled',
      'external-visible',
    ],
    inputSchema: shape,
    handler: async ({ limit, project }) => {
      let candidates;
      try {
        candidates = await deps.connector.fetchOpenPages(
          limit !== undefined ? { limit } : {},
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `sync_notion failed: ${msg}` }],
          isError: true,
        };
      }

      const created: string[] = [];
      let skippedExisting = 0;
      let skippedDone = 0;
      let skippedNoProject = 0;
      const errors: string[] = [];

      for (const candidate of candidates) {
        // Don't import pages already complete in Notion.
        if (isTerminalStatus(candidate.status)) {
          skippedDone += 1;
          continue;
        }
        // Dedup: a page already linked to a Symphony task is skipped.
        if (deps.externalLinkStore.getByExternal(NOTION_INTEGRATION, candidate.pageId)) {
          skippedExisting += 1;
          continue;
        }
        const projectId = resolveProjectId(deps, candidate.projectValue, project);
        if (projectId === undefined) {
          skippedNoProject += 1;
          errors.push(
            `Page "${truncate(candidate.title, 40)}": could not route to a project ` +
              `(Notion project: ${candidate.projectValue ?? 'none'}). Pass project:<name> or set_active_project first.`,
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
            source: NOTION_INTEGRATION,
            externalId: candidate.pageId,
            ...(candidate.url.length > 0 ? { url: candidate.url } : {}),
          });
          created.push(task.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Page "${truncate(candidate.title, 40)}": ${msg}`);
        }
      }

      const parts = [
        `Synced Notion: created ${created.length} task(s)`,
        skippedExisting > 0 ? `${skippedExisting} already imported` : null,
        skippedDone > 0 ? `${skippedDone} done` : null,
        skippedNoProject > 0 ? `${skippedNoProject} unroutable` : null,
      ].filter((p): p is string => p !== null);
      let text = `${parts.join(', ')}.`;
      if (errors.length > 0) {
        text += `\n${errors.map((e) => `  • ${e}`).join('\n')}`;
      }

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          created,
          createdCount: created.length,
          skippedExisting,
          skippedDone,
          skippedNoProject,
          errors,
        },
      };
    },
  };
}

/**
 * Resolve a candidate to a Symphony project id:
 *   1. the page's own Notion project value, if it matches a registered
 *      project name/id;
 *   2. the explicit `project` tool arg;
 *   3. the active-project cursor / boot default (via `resolveProjectPath`).
 * Returns `undefined` when nothing resolves.
 */
function resolveProjectId(
  deps: SyncNotionDeps,
  notionProjectValue: string | null,
  projectArg: string | undefined,
): string | undefined {
  if (notionProjectValue !== null) {
    const matched = deps.projectStore.get(notionProjectValue);
    if (matched) return matched.id;
  }
  if (projectArg !== undefined) {
    const matched = deps.projectStore.get(projectArg);
    if (matched) return matched.id;
  }
  if (deps.resolveProjectPath !== undefined) {
    // The server resolver THROWS for an unknown non-absolute name (see
    // server.ts resolveProjectPath). Swallow it so one bad `project:` arg
    // routes the page to `skippedNoProject` instead of aborting the whole
    // sync (audit M2).
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
