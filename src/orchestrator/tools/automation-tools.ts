import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type { AutomationRecord, AutomationStore } from '../../state/automation-store.js';
import { buildScheduleFromFlags, describeSchedule } from '../automation-schedule.js';
import type { ToolRegistration } from '../registry.js';

/**
 * Phase 8D.1 — agent-native automation management. Maestro-facing MCP tools
 * that mirror the `symphony automations …` CLI, so any automation a user can
 * create/manage from the terminal, Maestro can create/manage from a turn
 * (agent-native parity). They write the SHARED `automations` table (the same
 * store the Process-B scheduler ticks), so a Maestro-created automation fires
 * on the scheduler's next tick.
 *
 * All five are `scope: 'both'` (planning/management — available in PLAN and
 * ACT) with no capability flags: creating/managing an automation is local,
 * reversible, and not external-visible. The automation's RUNTIME is gated
 * separately (the injector's `automationContext` flag). The schedule is built
 * via the shared `buildScheduleFromFlags` so the CLI and the agent paths
 * produce identical schedules.
 */

const EVERY = ['hourly', 'daily', 'weekly', 'monthly'] as const;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function snapshot(r: AutomationRecord): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    projectId: r.projectId,
    schedule: r.schedule,
    scheduleText: r.schedule !== null ? describeSchedule(r.schedule) : null,
    enabled: r.enabled,
    inFlight: r.inFlight,
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    lastRunResult: r.lastRunResult,
    runCount: r.runCount,
    createdAt: r.createdAt,
  };
}

// ── create_automation ──────────────────────────────────────────────────────

const createShape = {
  name: z.string().min(1).describe('Short human label for the automation.'),
  prompt: z
    .string()
    .min(1)
    .describe(
      'The prompt fired into you (Maestro) each time the automation runs. Write it as a complete, self-contained instruction — it arrives as a fresh user turn with no prior context.',
    ),
  every: z.enum(EVERY).describe('Schedule interval.'),
  at: z
    .string()
    .optional()
    .describe('Time of day, `HH:MM` 24h (e.g. "09:30"). Hourly uses only the minute. Default 00:00.'),
  on: z.enum(DOW).optional().describe('Day of week for `every: "weekly"`. Default "mon".'),
  day: z
    .number()
    .int()
    .min(1)
    .max(31)
    .optional()
    .describe('Day of month (1-31) for `every: "monthly"`. Clamped to month length. Default 1.'),
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Target project name or id (context for the fired turn). Omit to use the active project (set via `set_active_project`).',
    ),
  enabled: z
    .boolean()
    .optional()
    .describe('Create disabled — it will not fire until you enable it. Default true.'),
};

export interface CreateAutomationDeps {
  readonly automationStore: AutomationStore;
  readonly projectStore: ProjectStore;
  /** Cursor-aware project resolution for an omitted `project:` (mirrors create_task). */
  readonly resolveProjectPath?: (project?: string) => string;
}

export function makeCreateAutomationTool(
  deps: CreateAutomationDeps,
): ToolRegistration<typeof createShape> {
  return {
    name: 'create_automation',
    description:
      'Schedule an automation that fires a prompt into you (Maestro) on a recurring schedule (hourly/daily/weekly/monthly). Use this for recurring user requests like "every morning, summarize new GitHub issues" or "every Friday at 5pm, run the test suite and report failures". The automation runs unattended whenever a Symphony session is open. Available in PLAN and ACT mode.',
    scope: 'both',
    capabilities: [],
    inputSchema: createShape,
    handler: ({ name, prompt, every, at, on, day, project, enabled }) => {
      let schedule;
      try {
        schedule = buildScheduleFromFlags({
          every,
          ...(at !== undefined ? { at } : {}),
          ...(on !== undefined ? { on } : {}),
          ...(day !== undefined ? { day: String(day) } : {}),
        });
      } catch (err) {
        return {
          content: [
            { type: 'text', text: `create_automation: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
      // Resolve the target project (cursor-aware, mirrors create_task).
      let projectId: string | null = null;
      if (project !== undefined && project.length > 0) {
        const p = deps.projectStore.get(project);
        if (p === undefined) {
          return { content: [{ type: 'text', text: `Unknown project '${project}'.` }], isError: true };
        }
        projectId = p.id;
      } else if (deps.resolveProjectPath !== undefined) {
        const cursorPath = deps.resolveProjectPath(undefined);
        for (const p of deps.projectStore.list()) {
          if (p.path === cursorPath) {
            projectId = p.id;
            break;
          }
        }
      }
      const record = deps.automationStore.create({
        name,
        prompt,
        schedule,
        projectId,
        enabled: enabled !== false,
      });
      return {
        content: [
          {
            type: 'text',
            text:
              `Automation ${record.id} '${record.name}' created — ${describeSchedule(schedule)}` +
              `${record.enabled ? '' : ' [disabled]'}; next run ${record.nextRunAt ?? '(none)'}.`,
          },
        ],
        structuredContent: snapshot(record),
      };
    },
  };
}

// ── list_automations ────────────────────────────────────────────────────────

const listShape = {} satisfies z.ZodRawShape;

export function makeListAutomationsTool(deps: {
  readonly automationStore: AutomationStore;
}): ToolRegistration<typeof listShape> {
  return {
    name: 'list_automations',
    description:
      'List all defined automations with their schedules, next-run times, enabled state, and run counts.',
    scope: 'both',
    capabilities: [],
    inputSchema: listShape,
    handler: () => {
      const records = deps.automationStore.list();
      const text =
        records.length === 0
          ? 'No automations defined. Create one with create_automation.'
          : records
              .map(
                (r) =>
                  `${r.id}  ${r.name} — ${r.schedule !== null ? describeSchedule(r.schedule) : '(no schedule)'}` +
                  `${r.enabled ? '' : ' [disabled]'}${r.inFlight ? ' [running]' : ''}` +
                  `  next ${r.nextRunAt ?? '(none)'}  runs ${r.runCount}`,
              )
              .join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: { automations: records.map(snapshot) },
      };
    },
  };
}

// ── remove_automation / set_automation_enabled / run_automation ──────────────

const idShape = {
  id: z.string().min(1).describe('The automation id (from list_automations / create_automation).'),
};

export function makeRemoveAutomationTool(deps: {
  readonly automationStore: AutomationStore;
}): ToolRegistration<typeof idShape> {
  return {
    name: 'remove_automation',
    description: 'Delete an automation (and its run logs) permanently. Use disable to pause without deleting.',
    scope: 'both',
    capabilities: [],
    inputSchema: idShape,
    handler: ({ id }) => {
      const removed = deps.automationStore.delete(id);
      if (!removed) {
        return { content: [{ type: 'text', text: `No automation with id '${id}'.` }], isError: true };
      }
      return { content: [{ type: 'text', text: `Automation '${id}' removed.` }] };
    },
  };
}

const setEnabledShape = {
  ...idShape,
  enabled: z.boolean().describe('true to enable (resume firing), false to disable (pause).'),
};

export function makeSetAutomationEnabledTool(deps: {
  readonly automationStore: AutomationStore;
}): ToolRegistration<typeof setEnabledShape> {
  return {
    name: 'set_automation_enabled',
    description:
      'Enable or disable an automation without deleting it. A disabled automation never fires until re-enabled.',
    scope: 'both',
    capabilities: [],
    inputSchema: setEnabledShape,
    handler: ({ id, enabled }) => {
      const ok = deps.automationStore.setEnabled(id, enabled);
      if (!ok) {
        return { content: [{ type: 'text', text: `No automation with id '${id}'.` }], isError: true };
      }
      return {
        content: [{ type: 'text', text: `Automation '${id}' ${enabled ? 'enabled' : 'disabled'}.` }],
      };
    },
  };
}

export interface RunAutomationDeps {
  readonly automationStore: AutomationStore;
  /** Injected clock (tests). Defaults to Date.now. */
  readonly now?: () => number;
}

export function makeRunAutomationTool(deps: RunAutomationDeps): ToolRegistration<typeof idShape> {
  const now = deps.now ?? Date.now;
  return {
    name: 'run_automation',
    description:
      'Force an automation to run now (out of schedule). It fires on the scheduler\'s next tick (within ~30s) while a session is open. The schedule is unchanged.',
    scope: 'both',
    capabilities: [],
    inputSchema: idShape,
    handler: ({ id }) => {
      const record = deps.automationStore.get(id);
      if (record === undefined) {
        return { content: [{ type: 'text', text: `No automation with id '${id}'.` }], isError: true };
      }
      if (!record.enabled) {
        return {
          content: [{ type: 'text', text: `Automation '${id}' is disabled — enable it first.` }],
          isError: true,
        };
      }
      deps.automationStore.forceDue(id, new Date(now()).toISOString());
      return {
        content: [
          { type: 'text', text: `Automation '${id}' will fire on the next scheduler tick.` },
        ],
      };
    },
  };
}
