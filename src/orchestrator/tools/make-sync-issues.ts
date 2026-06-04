import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type { ExternalLinkStore } from '../../state/external-link-store.js';
import type { TaskStore } from '../../state/types.js';
import type { IssueConnectorHandle } from '../../integrations/issue-connector.js';
import { ingestIssueCandidates } from '../../integrations/issue-ingest.js';
import type { ToolRegistration } from '../registry.js';

const shape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Max number of issues to pull this sync (default per connector, newest-updated first).'),
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Fallback project (name or id) for issues whose source routing value doesn't match a registered project. When omitted, falls back to the active project / boot default.",
    ),
};

export interface MakeSyncIssuesDeps {
  /** The issue-tracker connector (provides `source`, `fetchOpenIssues`). */
  readonly connector: IssueConnectorHandle;
  /** MCP tool name, e.g. `'sync_linear'`. */
  readonly name: string;
  /** MCP tool description. */
  readonly description: string;
  readonly taskStore: TaskStore;
  readonly projectStore: ProjectStore;
  readonly externalLinkStore: ExternalLinkStore;
  /**
   * Resolves a project name/path to an absolute path through the active-
   * project cursor + boot default (mirrors `create_task`). Final routing fallback.
   */
  readonly resolveProjectPath?: (project?: string) => string;
}

/**
 * Phase 8C — the generic `sync_<connector>` MCP tool. Pulls open issues from
 * the given connector and creates a Symphony task per NEW issue (deduped by
 * external link, so re-running is idempotent). Issues already terminal in the
 * source are skipped (don't import done work). The source owns task CREATION;
 * Symphony owns status thereafter and pushes terminal statuses back via the
 * writeback hook (see `makeIssueWritebackRef` / server.ts).
 *
 * One factory serves every connector (Linear, GitHub, …) — only `connector`,
 * `name`, and `description` differ.
 */
export function makeSyncIssuesTool(deps: MakeSyncIssuesDeps): ToolRegistration<typeof shape> {
  const source = deps.connector.source;
  return {
    name: deps.name,
    description: deps.description,
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
        candidates = await deps.connector.fetchOpenIssues(
          limit !== undefined ? { limit } : {},
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `${deps.name} failed: ${msg}` }],
          isError: true,
        };
      }

      const result = ingestIssueCandidates(
        candidates,
        {
          taskStore: deps.taskStore,
          projectStore: deps.projectStore,
          externalLinkStore: deps.externalLinkStore,
          ...(deps.resolveProjectPath !== undefined
            ? { resolveProjectPath: deps.resolveProjectPath }
            : {}),
        },
        source,
        project,
      );

      const label = source.charAt(0).toUpperCase() + source.slice(1);
      const parts = [
        `Synced ${label}: created ${result.created.length} task(s)`,
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
