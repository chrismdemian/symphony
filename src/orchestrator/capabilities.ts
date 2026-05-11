import type { CapabilityDecision, CapabilityFlag, DispatchContext } from './types.js';

export class CapabilityEvaluator {
  evaluate(flags: readonly CapabilityFlag[], ctx: DispatchContext): CapabilityDecision {
    if (flags.includes('writes-source')) {
      return { allow: false, reason: 'Maestro delegator must never edit source files directly' };
    }

    if (flags.includes('requires-host-browser-control')) {
      if (ctx.mode !== 'act') {
        return { allow: false, reason: 'host-browser-control requires act mode' };
      }
      if (ctx.tier !== 3) {
        return { allow: false, reason: 'host-browser-control requires tier 3 (confirm)' };
      }
      if (ctx.awayMode) {
        // Phase 3M — copy aligned with PLAN.md §3M spec line 1326.
        return {
          allow: false,
          reason:
            'tool unavailable: away mode active; capability requires:host-browser-control demands user presence',
        };
      }
      if (ctx.automationContext) {
        return { allow: false, reason: 'host-browser-control cannot run from automation' };
      }
    }

    if (flags.includes('irreversible') && ctx.tier < 3) {
      return { allow: false, reason: 'irreversible action requires tier 3 (confirm)' };
    }

    if (flags.includes('external-visible') && ctx.tier < 2) {
      return { allow: false, reason: 'external-visible action requires tier 2 or higher' };
    }

    return { allow: true };
  }
}

export const DEFAULT_DISPATCH_CONTEXT: DispatchContext = {
  mode: 'plan',
  tier: 2,
  awayMode: false,
  automationContext: false,
};
