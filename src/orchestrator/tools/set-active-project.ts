/**
 * Phase 5D — `set_active_project` MCP tool.
 *
 * Switches the orchestrator's active-project routing default to the
 * named project. Subsequent tool calls that omit `project:` resolve
 * through the active-project cursor before falling back to the boot
 * `defaultProjectPath`. Explicit `project:` args always win.
 *
 * Maestro calls this when the user mentions a project ("in
 * MathScrabble do X", "/project Axon", etc.). The protocol fragment
 * `maestro-active-project.md` documents the detection rules; this
 * tool is the commit point.
 *
 * Persistence: writes `config.activeProject` to `~/.symphony/config.json`
 * via the same `applyPatchToDisk` queue the TUI uses, so the choice
 * survives across `symphony start` restarts. `null` clears the cursor
 * and returns the resolver to its boot fallback chain
 * (`defaultProjectPath` → first registered project).
 */
import { z } from 'zod';

import type { ProjectStore } from '../../projects/types.js';
import type { ToolRegistration } from '../registry.js';

const shape = {
  project_name: z
    .string()
    .min(1)
    .describe(
      'Project name or id to mark active. Pass the special string "(none)" to clear the active project and return Symphony to the boot default routing. Absolute paths are NOT accepted — register the project first via `symphony add`.',
    ),
};

/**
 * Sentinel a caller passes as `project_name` to clear the active
 * project. We accept a literal magic string rather than allowing
 * `null` / `undefined` so the Zod schema can stay `z.string().min(1)`
 * (matching `get_project_info`'s shape) — easier for Maestro to
 * remember a single conventional argument shape across all
 * project-targeted tools.
 *
 * Exported so the Phase 5D drift-lock test
 * (`tests/integration/5d-prompt-drift.integration.test.ts`) can assert
 * that the Maestro v1 prompt + the regenerated fragment mention
 * `set_active_project("(none)")` verbatim. Renaming the sentinel
 * requires editing the prompt + this constant + `pnpm gen:fragments`;
 * the drift-lock test fails CI otherwise.
 */
export const SET_ACTIVE_PROJECT_CLEAR_SENTINEL = '(none)';

/**
 * The dispatch-side setter (declared on `RouterDeps.setDispatchActiveProject`
 * in `src/rpc/router-impl.ts`). The tool reaches it via
 * `OrchestratorServerOptions.setActiveProjectController` so the same
 * closure that the `runtime.setActiveProject` RPC fires also runs
 * here — audit-log + chat-row signal are guaranteed regardless of
 * which entry point flipped the cursor.
 *
 * `persist` is split out so tests can stub disk I/O without standing
 * up `~/.symphony/config.json`. Production wires it to
 * `applyPatchToDisk({activeProject: <name|null>})`.
 */
export interface SetActiveProjectDeps {
  readonly projectStore: ProjectStore;
  readonly setDispatchActiveProject: (project: string | null) => void;
  readonly persist: (project: string | null) => Promise<void>;
}

export function makeSetActiveProjectTool(
  deps: SetActiveProjectDeps,
): ToolRegistration<typeof shape> {
  return {
    name: 'set_active_project',
    description:
      'Set the active project for subsequent tool calls. Calls that omit `project:` will resolve through this active-project cursor before falling back to the boot default. Pass "(none)" to clear. Persists to ~/.symphony/config.json. Planning tool — available in PLAN and ACT mode.',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: async ({ project_name }) => {
      if (project_name === SET_ACTIVE_PROJECT_CLEAR_SENTINEL) {
        try {
          await deps.persist(null);
        } catch (err) {
          return errorResult(
            `set_active_project failed to persist clear: ${describe(err)}`,
          );
        }
        deps.setDispatchActiveProject(null);
        return {
          content: [
            {
              type: 'text',
              text: 'Active project cleared. Subsequent tool calls without `project:` will use the boot default.',
            },
          ],
          structuredContent: {
            active: null,
          },
        };
      }
      const snap = deps.projectStore.snapshot(project_name);
      if (snap === undefined) {
        const known = deps.projectStore
          .snapshots({})
          .map((p) => p.name)
          .slice(0, 12);
        const hint =
          known.length === 0
            ? 'No projects registered. Use `symphony add <path>` first.'
            : `Known: ${known.join(', ')}${known.length === 12 ? ', …' : ''}.`;
        return errorResult(`Unknown project '${project_name}'. ${hint}`);
      }
      try {
        await deps.persist(snap.name);
      } catch (err) {
        return errorResult(
          `set_active_project failed to persist '${snap.name}': ${describe(err)}`,
        );
      }
      // Cursor update fires audit + chat-row through the central
      // closure in server.ts (`setDispatchActiveProject`).
      deps.setDispatchActiveProject(snap.name);
      return {
        content: [
          {
            type: 'text',
            text: `Active project → ${snap.name} (${snap.path}). Subsequent tool calls without \`project:\` will route here.`,
          },
        ],
        structuredContent: {
          active: snap as unknown as Record<string, unknown>,
        },
      };
    },
  };
}

function errorResult(text: string): ReturnType<
  NonNullable<ToolRegistration<typeof shape>['handler']>
> {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
