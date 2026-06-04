import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type { ExternalLinkStore } from '../../state/external-link-store.js';
import type { TaskStore } from '../../state/types.js';
import {
  ingestObsidianCandidates,
  type ObsidianIngestDeps,
} from '../../integrations/obsidian-ingest.js';
import type { ObsidianConnectorHandle } from '../../integrations/obsidian.js';
import type { ToolRegistration } from '../registry.js';

const shape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('Max number of open vault tasks to pull this sync (default 200).'),
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Fallback project (name or id) for tasks whose note frontmatter project doesn't match a registered project. When omitted, falls back to the active project / boot default.",
    ),
};

export interface SyncObsidianDeps {
  readonly connector: ObsidianConnectorHandle;
  readonly taskStore: TaskStore;
  readonly projectStore: ProjectStore;
  readonly externalLinkStore: ExternalLinkStore;
  /**
   * Resolves a project name/path to an absolute path through the active-
   * project cursor + boot default (mirrors `create_task`). Final fallback when
   * a note's frontmatter project value matches nothing.
   */
  readonly resolveProjectPath?: (project?: string) => string;
}

/**
 * Phase 8B — `sync_obsidian`. Pulls open markdown tasks from the configured
 * Obsidian vault and creates a Symphony task per NEW task line (deduped by
 * external link, so re-running is idempotent). Tasks already checked off /
 * cancelled in the vault are skipped. The vault is the source for task
 * CREATION; Symphony owns status thereafter and flips the checkbox back via
 * the writeback hook (see server.ts).
 */
export function makeSyncObsidianTool(
  deps: SyncObsidianDeps,
): ToolRegistration<typeof shape> {
  return {
    name: 'sync_obsidian',
    description:
      'Pull open tasks from the configured Obsidian vault into Symphony. Creates one pending task per new markdown task line (idempotent — already-imported lines are skipped). Maps task text→description, note frontmatter project→project routing, Tasks-plugin priority→priority; skips lines already checked off/cancelled. Requires `symphony config obsidian`.',
    scope: 'both',
    capabilities: ['external-visible'],
    inputSchema: shape,
    handler: async ({ limit, project }) => {
      let candidates;
      try {
        candidates = await deps.connector.fetchOpenTasks(
          limit !== undefined ? { limit } : {},
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `sync_obsidian failed: ${msg}` }],
          isError: true,
        };
      }

      const ingestDeps: ObsidianIngestDeps = {
        taskStore: deps.taskStore,
        projectStore: deps.projectStore,
        externalLinkStore: deps.externalLinkStore,
        ...(deps.resolveProjectPath !== undefined
          ? { resolveProjectPath: deps.resolveProjectPath }
          : {}),
      };
      const result = ingestObsidianCandidates(candidates, ingestDeps, project);

      const parts = [
        `Synced Obsidian: created ${result.created.length} task(s)`,
        result.skippedExisting > 0 ? `${result.skippedExisting} already imported` : null,
        result.skippedDone > 0 ? `${result.skippedDone} done` : null,
        result.skippedNoProject > 0 ? `${result.skippedNoProject} unroutable` : null,
      ].filter((p): p is string => p !== null);
      let text = `${parts.join(', ')}.`;
      if (result.errors.length > 0) {
        text += `\n${result.errors.map((e) => `  • ${e}`).join('\n')}`;
      }

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          created: result.created,
          createdCount: result.created.length,
          skippedExisting: result.skippedExisting,
          skippedDone: result.skippedDone,
          skippedNoProject: result.skippedNoProject,
          errors: result.errors,
        },
      };
    },
  };
}
