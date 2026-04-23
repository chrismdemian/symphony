import { z } from 'zod';
import type { ToolRegistration } from '../registry.js';

const ledgerShape = {
  ledger: z.object({
    is_plan_complete: z.boolean().optional(),
    is_in_loop: z.boolean().optional(),
    is_making_progress: z.boolean().optional(),
    workers_in_flight: z
      .array(
        z.object({
          id: z.string(),
          feature_intent: z.string().optional(),
          status: z.string().optional(),
        }),
      )
      .optional(),
    blockers: z.array(z.string()).optional(),
    next_action: z.string().optional(),
    reason: z.string().optional(),
  }),
};

export const thinkTool: ToolRegistration<typeof ledgerShape> = {
  name: 'think',
  description:
    "Private progress ledger. Not shown to the USER. Call before each ACT decision with a one-shot JSON ledger summarizing plan completeness, loop state, progress, in-flight workers, blockers, and next action.",
  scope: 'both',
  capabilities: [],
  inputSchema: ledgerShape,
  handler: ({ ledger }) => ({
    content: [{ type: 'text', text: 'ledger recorded' }],
    structuredContent: { recorded: ledger as Record<string, unknown> },
  }),
};
