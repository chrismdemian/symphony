import { z } from 'zod';
import type { ToolRegistration } from '../registry.js';

export interface ProposedPlan {
  plan: string;
  autonomyTier: 1 | 2 | 3;
  proposedAt: number;
}

export interface ProposePlanStore {
  setLastPlan(plan: ProposedPlan): void;
  getLastPlan(): ProposedPlan | null;
}

export function createProposePlanStore(): ProposePlanStore {
  let last: ProposedPlan | null = null;
  return {
    setLastPlan: (plan: ProposedPlan) => {
      last = plan;
    },
    getLastPlan: () => last,
  };
}

const shape = {
  plan: z.string().min(1).describe('The full plan text, markdown formatted.'),
  autonomy_tier: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .describe('1 = free reign, 2 = notify, 3 = confirm.'),
};

export function makeProposePlanTool(store: ProposePlanStore): ToolRegistration<typeof shape> {
  return {
    name: 'propose_plan',
    description:
      'PLAN-mode only. Emit a concrete implementation plan. Symphony stores it and surfaces to the USER for approval. On approval, Maestro switches to ACT mode.',
    scope: 'plan',
    capabilities: [],
    inputSchema: shape,
    handler: ({ plan, autonomy_tier }) => {
      const record: ProposedPlan = { plan, autonomyTier: autonomy_tier, proposedAt: Date.now() };
      store.setLastPlan(record);
      return {
        content: [{ type: 'text', text: 'plan proposed; awaiting user approval token' }],
        structuredContent: { proposedAt: record.proposedAt, autonomyTier: autonomy_tier },
      };
    },
  };
}
