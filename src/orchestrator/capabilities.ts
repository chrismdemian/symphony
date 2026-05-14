import type { CapabilityDecision, CapabilityFlag, DispatchContext } from './types.js';

/**
 * Phase 2A.1 (host-browser-control + irreversible + external-visible) +
 * Phase 3S (secrets-read + network-egress-uncontrolled + first-use notice).
 *
 * Floor-vs-exact-tier distinction:
 *   - `requires-host-browser-control`: EXACT Tier 3 (line below) — the
 *     plugin envelope can't be relaxed even at higher tiers because there
 *     IS no higher tier today.
 *   - `irreversible`: `>= Tier 3` — same exact-3 in practice today, kept
 *     as `<` for symmetry with potential future Tier 4.
 *   - `external-visible`, `requires-secrets-read`,
 *     `requires-network-egress-uncontrolled`: `>= Tier 2` floor — the tool
 *     is allowed at Tier 2 and Tier 3, denied at Tier 1.
 *
 * First-use notice (Phase 3S): when `requires-secrets-read` first fires
 * at Tier 2 within this evaluator instance's lifetime, the decision
 * carries an attached `notice` so the dispatch shim's noticeSink can
 * surface a TUI toast. Subsequent calls for the same (flag, tool) pair
 * don't re-fire until `resetFirstUseTracker()` runs (called on tier
 * change by `runtime.setAutonomyTier`'s RouterDeps closure). Tier 3 does
 * NOT emit a notice — at Tier 3 the user is conceptually in confirm-each-
 * action mode, so a separate first-use signal is redundant. Tier 1 is
 * already a denial — never emits.
 */
export class CapabilityEvaluator {
  private readonly seenFirstUse = new Set<string>();

  evaluate(
    flags: readonly CapabilityFlag[],
    ctx: DispatchContext,
    toolName?: string,
  ): CapabilityDecision {
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

    // Phase 3S — new tier floors.
    if (flags.includes('requires-secrets-read') && ctx.tier < 2) {
      return {
        allow: false,
        reason: 'requires-secrets-read action requires tier 2 (notify) or higher',
      };
    }

    if (flags.includes('requires-network-egress-uncontrolled') && ctx.tier < 2) {
      return {
        allow: false,
        reason:
          'requires-network-egress-uncontrolled action requires tier 2 (notify) or higher',
      };
    }

    // Phase 3S — first-use notice. Only fires at Tier 2 (Notify) — Tier 3
    // is implicit confirm-each-action and Tier 1 is already denied above.
    if (
      toolName !== undefined &&
      ctx.tier === 2 &&
      flags.includes('requires-secrets-read')
    ) {
      const key = `requires-secrets-read::${toolName}`;
      if (!this.seenFirstUse.has(key)) {
        this.seenFirstUse.add(key);
        return {
          allow: true,
          notice: { kind: 'first-use', tool: toolName, flag: 'requires-secrets-read' },
        };
      }
    }

    return { allow: true };
  }

  /**
   * Phase 3S — clear the first-use seen-set. Called by the RouterDeps
   * closure for `runtime.setAutonomyTier`: changing the global tier
   * implicitly re-confirms the user's intent, so the next secrets-read
   * tool call should re-emit the first-use notice.
   *
   * Also called on server restart (instance lifetime) — the constructor
   * always starts with an empty set, so each Symphony session emits at
   * most one first-use notice per (flag, tool) pair.
   */
  resetFirstUseTracker(): void {
    this.seenFirstUse.clear();
  }
}

export const DEFAULT_DISPATCH_CONTEXT: DispatchContext = {
  mode: 'plan',
  tier: 2,
  awayMode: false,
  automationContext: false,
};
