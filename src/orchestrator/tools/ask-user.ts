import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import {
  toQuestionSnapshot,
  type QuestionStore,
  type QuestionUrgency,
} from '../../state/question-registry.js';
import type { ToolRegistration } from '../registry.js';

const URGENCY_VALUES = ['blocking', 'advisory'] as const;

const shape = {
  question: z
    .string()
    .min(1)
    .describe('Human-readable question for the USER. Keep it short and concrete.'),
  context: z
    .string()
    .optional()
    .describe('Optional background — cite file:line, link a diff, quote a plan entry.'),
  project: z
    .string()
    .optional()
    .describe('Optional project name/id to scope the question. Required when worker_id is absent to disambiguate across projects.'),
  worker_id: z
    .string()
    .optional()
    .describe('Optional worker id this question is about (e.g., "wk-abcd1234").'),
  urgency: z
    .enum(URGENCY_VALUES)
    .optional()
    .describe('"blocking" (default) halts work until answered; "advisory" batches in the TUI.'),
};

export interface AskUserDeps {
  readonly questionStore: QuestionStore;
  readonly projectStore: ProjectStore;
}

export function makeAskUserTool(deps: AskUserDeps): ToolRegistration<typeof shape> {
  return {
    name: 'ask_user',
    description:
      'Queue a question for the USER. Use sparingly — bias toward deciding and noting rather than asking. Returns immediately; answering happens out-of-band via the TUI. Available in both PLAN and ACT mode.',
    scope: 'both',
    capabilities: [],
    inputSchema: shape,
    handler: ({ question, context, project, worker_id, urgency }) => {
      let projectId: string | undefined;
      if (project !== undefined) {
        const proj = deps.projectStore.get(project);
        if (!proj) {
          return {
            content: [{ type: 'text', text: `Unknown project '${project}'.` }],
            isError: true,
          };
        }
        projectId = proj.id;
      }

      try {
        const record = deps.questionStore.enqueue({
          question,
          ...(context !== undefined ? { context } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
          ...(worker_id !== undefined ? { workerId: worker_id } : {}),
          ...(urgency !== undefined ? { urgency: urgency as QuestionUrgency } : {}),
        });
        const snap = toQuestionSnapshot(record);
        return {
          content: [
            {
              type: 'text',
              text: `Question ${snap.id} queued [${snap.urgency}]; awaiting USER answer.`,
            },
          ],
          structuredContent: snap as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `ask_user failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}
