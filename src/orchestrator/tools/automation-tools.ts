import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import type { AutomationRecord, AutomationStore } from '../../state/automation-store.js';
import {
  buildScheduleFromFlags,
  describeAutomationMode,
  describeSchedule,
} from '../automation-schedule.js';
import { KNOWN_TRIGGER_TYPES } from '../automation-trigger-source.js';
import {
  buildTriggerConfigJson,
  describeTriggerFilters,
  parseTriggerConfig,
} from '../trigger-filter.js';
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
    triggerType: r.triggerType,
    triggerConfig: parseTriggerConfig(r.triggerConfig),
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
      'The prompt fired into you (Maestro) each time the automation runs. Write it as a complete, self-contained instruction — it arrives as a fresh user turn with no prior context. For a trigger automation, event context (the issue title + URL) is prepended automatically.',
    ),
  every: z
    .enum(EVERY)
    .optional()
    .describe(
      'Schedule interval for a SCHEDULE automation (fires on a clock). Mutually exclusive with `triggerType`. Provide exactly one of `every` / `triggerType`.',
    ),
  triggerType: z
    .enum(KNOWN_TRIGGER_TYPES)
    .optional()
    .describe(
      'Event source for a TRIGGER automation (fires when a new issue/thread/error appears). One of github_issue | linear_issue | jira_issue | gitlab_issue | plain_thread | forgejo_issue | sentry_error. Requires the matching `symphony config <connector>`. Mutually exclusive with `every`.',
    ),
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
  labelFilter: z
    .array(z.string().min(1))
    .optional()
    .describe(
      'TRIGGER filter (ignored for a schedule): only fire for events carrying at least one of these labels (case-insensitive OR). E.g. ["bug","urgent"].',
    ),
  assigneeFilter: z
    .string()
    .min(1)
    .optional()
    .describe('TRIGGER filter: only fire for events assigned to this user (case-insensitive exact).'),
  branchFilter: z
    .string()
    .min(1)
    .optional()
    .describe(
      'TRIGGER filter: only fire for events on a matching branch (glob `*`, e.g. "feature/*"). Applies to PR sources only; issue triggers ignore it.',
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
      'Create an automation that fires a prompt into you (Maestro) automatically. Two modes: SCHEDULE (`every: hourly|daily|weekly|monthly`) for recurring clock-based runs like "every morning, summarize new GitHub issues"; or TRIGGER (`triggerType: github_issue|linear_issue|…`) for event-driven runs like "whenever a new GitHub issue appears, triage it". Provide exactly one of `every` / `triggerType`. The automation runs unattended whenever a Symphony session is open. Available in PLAN and ACT mode.',
    scope: 'both',
    capabilities: [],
    inputSchema: createShape,
    handler: ({
      name,
      prompt,
      every,
      triggerType,
      at,
      on,
      day,
      project,
      labelFilter,
      assigneeFilter,
      branchFilter,
      enabled,
    }) => {
      // Exactly one of schedule / trigger.
      if (every !== undefined && triggerType !== undefined) {
        return {
          content: [
            { type: 'text', text: 'create_automation: provide exactly one of `every` (schedule) or `triggerType` (trigger), not both.' },
          ],
          isError: true,
        };
      }
      if (every === undefined && triggerType === undefined) {
        return {
          content: [
            { type: 'text', text: 'create_automation: provide either `every` (schedule) or `triggerType` (trigger).' },
          ],
          isError: true,
        };
      }
      // Phase 8D.4 — filters are trigger-only (a schedule has no event to filter).
      const hasFilter =
        (labelFilter !== undefined && labelFilter.length > 0) ||
        assigneeFilter !== undefined ||
        branchFilter !== undefined;
      if (hasFilter && triggerType === undefined) {
        return {
          content: [
            { type: 'text', text: 'create_automation: `labelFilter` / `assigneeFilter` / `branchFilter` are only valid with `triggerType`.' },
          ],
          isError: true,
        };
      }
      let schedule;
      if (every !== undefined) {
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
      const triggerConfig =
        triggerType !== undefined
          ? buildTriggerConfigJson({
              ...(labelFilter !== undefined ? { labels: labelFilter } : {}),
              ...(assigneeFilter !== undefined ? { assignee: assigneeFilter } : {}),
              ...(branchFilter !== undefined ? { branch: branchFilter } : {}),
            })
          : null;
      const record = deps.automationStore.create({
        name,
        prompt,
        ...(schedule !== undefined ? { schedule } : {}),
        ...(triggerType !== undefined ? { triggerType } : {}),
        ...(triggerConfig !== null ? { triggerConfig } : {}),
        projectId,
        enabled: enabled !== false,
      });
      const filterText = describeTriggerFilters(parseTriggerConfig(record.triggerConfig));
      return {
        content: [
          {
            type: 'text',
            text:
              `Automation ${record.id} '${record.name}' created — ${describeAutomationMode(record.schedule, record.triggerType)}` +
              `${filterText.length > 0 ? ` (${filterText})` : ''}` +
              `${record.enabled ? '' : ' [disabled]'}` +
              `${record.nextRunAt !== null ? `; next run ${record.nextRunAt}` : ''}.`,
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
                  `${r.id}  ${r.name} — ${describeAutomationMode(r.schedule, r.triggerType)}` +
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
