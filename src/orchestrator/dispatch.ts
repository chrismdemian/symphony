import { CapabilityDeniedError, SafetyGuardError } from './types.js';
import type {
  CapabilityFlag,
  CapabilityNotice,
  DispatchContext,
  ToolScope,
} from './types.js';
import type { CapabilityEvaluator } from './capabilities.js';
import type { AgentSafetyGuard } from './safety.js';

export interface ToolHandlerResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export type ToolHandler<TArgs extends Record<string, unknown>> = (
  args: TArgs,
  ctx: DispatchContext,
) => Promise<ToolHandlerResult> | ToolHandlerResult;

export interface WrapToolHandlerOptions<TArgs extends Record<string, unknown>> {
  name: string;
  scope: ToolScope;
  capabilities: readonly CapabilityFlag[];
  handler: ToolHandler<TArgs>;
  safety: AgentSafetyGuard;
  capabilityEvaluator: CapabilityEvaluator;
  getContext: () => DispatchContext;
  /**
   * Phase 3S — optional sink for capability-decision notices. Invoked when
   * the evaluator returns `allow: true` AND attaches a `notice` (e.g.
   * first-use of a `requires-secrets-read` tool at Tier 2). Server wires
   * this to a TUI toast broker so the user sees a one-shot heads-up
   * independent of `notifications.enabled` / TTY / CI suppression.
   *
   * Failures inside the sink are swallowed — a misbehaving toast must
   * never block a tool from executing. The sink fires AFTER the
   * capability check passes but BEFORE the safety budget check and
   * handler invocation; this ordering means a tool denied by the safety
   * guard still records its first-use notice (because the user's intent
   * to invoke was recorded by the capability evaluator's seen-set
   * mutation).
   */
  noticeSink?: (notice: CapabilityNotice) => void;
}

function isSafetyError(err: unknown): err is SafetyGuardError {
  return err instanceof SafetyGuardError;
}

function isCapabilityError(err: unknown): err is CapabilityDeniedError {
  return err instanceof CapabilityDeniedError;
}

function errorResult(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Phase 3S — per-worker autonomy tier is NOT enforced here. The
 * temptation is to peek at `args.worker_id` and substitute the
 * worker's tier into the DispatchContext for that call — but that's
 * incoherent for Symphony's architecture:
 *
 *   - Workers run as `claude -p` subprocesses that do NOT dispatch
 *     through this shim (no `--mcp-config` is passed; see
 *     `src/workers/args.ts`).
 *   - The `worker_id` arg on Maestro's tools (kill_worker,
 *     send_to_worker, audit_changes, finalize) names the TARGET of
 *     Maestro's action, not the CALLER. Flipping Maestro's tier to
 *     the worker's tier would LOWER Maestro's autonomy when it acts
 *     on a high-tier worker — the opposite of the intended policy.
 *
 * Per-worker tier is therefore METADATA-ONLY in 3S: surfaced in
 * `list_workers` for Maestro prompt awareness and as a worker-row
 * chip in the TUI. The real architectural enforcement lands when
 * Phase 7 plugins introduce worker-side MCP tooling — at that point
 * the worker's OWN dispatch shim reads from the worker's tier.
 */
export function wrapToolHandler<TArgs extends Record<string, unknown>>(
  opts: WrapToolHandlerOptions<TArgs>,
): (args: TArgs, signal?: AbortSignal) => Promise<ToolHandlerResult> {
  const {
    name,
    scope,
    capabilities,
    handler,
    safety,
    capabilityEvaluator,
    getContext,
    noticeSink,
  } = opts;

  return async (args: TArgs, signal?: AbortSignal): Promise<ToolHandlerResult> => {
    const base = getContext();
    const ctx: DispatchContext = signal ? { ...base, signal } : base;

    if (scope !== 'both' && scope !== ctx.mode) {
      return errorResult(`tool '${name}' is not available in ${ctx.mode} mode`);
    }

    // Phase 3T — short-circuit ACT-scope tools while an interrupt pivot is
    // pending. Maestro's still-streaming turn (from before the pivot) can
    // try to spawn fresh workers via tool calls; without this gate, those
    // calls race the `setInterruptPending(true)` write and slip through.
    //
    // The flag is cleared by `MaestroProcess.sendUserMessage` after it
    // wraps the user's NEXT message with the `[INTERRUPT NOTICE]`
    // envelope — so a tool returning this error during the pivoted turn
    // is exactly the intended outcome (Maestro sees the error, finishes
    // the turn briefly, awaits the user's new direction).
    //
    // Plan-scope tools (read-only: `list_workers`, `get_worker_output`,
    // `list_tasks`) are NOT gated — Maestro may need to inspect state
    // while drafting its acknowledgement. `'both'`-scope tools are
    // treated like plan (read-leaning by convention; the few `'both'`
    // tools today are status/lookup operations).
    if (ctx.interruptPending === true && scope === 'act') {
      return errorResult(
        `tool '${name}' blocked: user pivoted previous turn — workers killed, queue cleared, await new direction`,
      );
    }

    // Phase 3S — pass `name` so the evaluator can key its first-use
    // tracker per (flag, tool) pair. Existing call sites that don't pass
    // a name (e.g. unit tests against the evaluator alone) get the
    // 2A.1 behavior unchanged — `toolName === undefined` skips the
    // first-use branch.
    const decision = capabilityEvaluator.evaluate(capabilities, ctx, name);
    if (!decision.allow) {
      return errorResult(`tool '${name}' denied by capability policy: ${decision.reason ?? 'unspecified'}`);
    }
    if (decision.notice !== undefined && noticeSink !== undefined) {
      try {
        noticeSink(decision.notice);
      } catch {
        // Sink failure must never block a tool — drop silently and let
        // the dispatch continue. The seen-set is already mutated, so we
        // won't re-fire next call.
      }
    }

    try {
      safety.validateToolCall(name, args as Readonly<Record<string, unknown>>);
    } catch (err) {
      if (isSafetyError(err)) return errorResult(err.message);
      throw err;
    }

    let result: ToolHandlerResult;
    try {
      result = await handler(args, ctx);
    } catch (err) {
      if (isSafetyError(err)) return errorResult(err.message);
      if (isCapabilityError(err)) return errorResult(err.message);
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(`tool '${name}' raised: ${message}`);
    }

    // Safety token budget tracks content the model will receive.
    // isError results are the shim's own protocol metadata, not model input — don't charge them.
    if (!result.isError) {
      try {
        const textParts = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        // Modern MCP clients surface structuredContent to the LLM alongside
        // the text block (per 2A.2 review §M3). Charge both against the
        // budget, otherwise tools that return large structured payloads
        // (get_worker_output with lines=500) silently exhaust context without
        // ever tripping `context-cap`.
        const structuredText =
          result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : '';
        const totalText =
          structuredText.length > 0 ? `${textParts}\n${structuredText}` : textParts;
        if (totalText.length > 0) safety.recordResponseTokens(totalText);
      } catch {
        // non-fatal accounting failure
      }
    }

    return result;
  };
}
