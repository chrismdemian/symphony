import { CapabilityDeniedError, SafetyGuardError } from './types.js';
import type {
  CapabilityFlag,
  CapabilityNotice,
  DispatchContext,
  ToolScope,
} from './types.js';
import type { CapabilityEvaluator } from './capabilities.js';
import type { AgentSafetyGuard } from './safety.js';

/**
 * Phase 3R — `auditSink` payload for one tool dispatch. The shim emits
 * exactly one record per call; `kind` reflects the outcome path so the
 * /log filter can isolate denials and errors without scanning every
 * tool_called row.
 *
 * Phase 7's "non-defeatable audit BEFORE dispatch" mandate is satisfied
 * by the shim's central position: every tool — Symphony's MCP tools AND
 * future Phase 7 plugin tools — flows through here. A plugin's
 * additional pre-network audit emit (e.g. browser-tab open) is the
 * plugin shim's responsibility on top of this baseline.
 */
export type ToolAuditOutcome = 'ok' | 'denied' | 'error';
export interface ToolAuditRecord {
  readonly name: string;
  readonly scope: ToolScope;
  readonly capabilities: readonly CapabilityFlag[];
  readonly tier: number;
  readonly mode: string;
  readonly outcome: ToolAuditOutcome;
  /** Truncated JSON of the args; sanitization is the sink's job. */
  readonly args: Readonly<Record<string, unknown>>;
  /** Populated for `denied` (capability reason) and `error` (message). */
  readonly reason?: string;
}
export type ToolAuditSink = (record: ToolAuditRecord) => void;

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
  /**
   * Phase 3R — optional sink for tool-dispatch audit records. Emits
   * exactly one record per `wrapToolHandler` invocation regardless of
   * outcome (ok / denied / error). Sink failures are swallowed — a
   * misbehaving audit consumer must never block a tool from executing.
   *
   * Reaches an `AuditLogger.append({kind: 'tool_called'|'tool_denied'|
   * 'tool_error', ...})` call wired in `server.ts`. Server is responsible
   * for sanitizing `args` payload before writing to SQLite.
   */
  auditSink?: ToolAuditSink;
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
    auditSink,
  } = opts;

  function emitAudit(
    ctx: DispatchContext,
    args: TArgs,
    outcome: ToolAuditOutcome,
    reason?: string,
  ): void {
    if (auditSink === undefined) return;
    try {
      auditSink({
        name,
        scope,
        capabilities,
        tier: ctx.tier,
        mode: ctx.mode,
        outcome,
        args,
        reason,
      });
    } catch {
      // Audit sink failure must never block dispatch.
    }
  }

  return async (args: TArgs, signal?: AbortSignal): Promise<ToolHandlerResult> => {
    const base = getContext();
    const ctx: DispatchContext = signal ? { ...base, signal } : base;

    if (scope !== 'both' && scope !== ctx.mode) {
      emitAudit(ctx, args, 'denied', `not available in ${ctx.mode} mode`);
      return errorResult(`tool '${name}' is not available in ${ctx.mode} mode`);
    }

    // Phase 3T — short-circuit ACT-scope tools while an interrupt pivot
    // is pending on THIS server. Maestro's still-streaming turn (from
    // before the pivot) can try to spawn fresh workers via tool calls;
    // without this gate, those calls race the `setInterruptPending(true)`
    // write and slip through. The flag is cleared by the TUI's explicit
    // `runtime.clearInterruptPending` RPC AFTER it wraps + sends the
    // user's next message via `MaestroDataController.sendUserMessage`.
    //
    // **Cross-process limitation (audit 3T Major #2):** this gate fires
    // only on the server that received `runtime.interrupt`. Maestro's
    // MCP child runs in a SEPARATE process (`maestro/mcp-config.ts:70`)
    // with its own dispatch-context cursor; tool calls Maestro emits
    // from its still-streaming turn dispatch through THAT server,
    // whose `interruptPending` stays false. The user-facing protection
    // that crosses the process boundary is the `[INTERRUPT NOTICE]`
    // envelope wrap (TUI-side); this server-side shim is belt-and-
    // suspenders only on single-process test rigs. Phase 5/8 cross-
    // process IPC will close the gap.
    //
    // Plan-scope + `'both'`-scope tools (read-only: `list_workers`,
    // `get_worker_output`, `list_tasks`, `global_status`) are NOT
    // gated — Maestro may need to inspect state while drafting its
    // acknowledgement.
    if (ctx.interruptPending === true && scope === 'act') {
      emitAudit(ctx, args, 'denied', 'interrupt pending — pivot pending new direction');
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
      emitAudit(ctx, args, 'denied', `capability policy: ${decision.reason ?? 'unspecified'}`);
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
      if (isSafetyError(err)) {
        emitAudit(ctx, args, 'denied', `safety: ${err.message}`);
        return errorResult(err.message);
      }
      throw err;
    }

    let result: ToolHandlerResult;
    try {
      result = await handler(args, ctx);
    } catch (err) {
      if (isSafetyError(err)) {
        emitAudit(ctx, args, 'denied', `safety: ${err.message}`);
        return errorResult(err.message);
      }
      if (isCapabilityError(err)) {
        emitAudit(ctx, args, 'denied', `capability: ${err.message}`);
        return errorResult(err.message);
      }
      const message = err instanceof Error ? err.message : String(err);
      emitAudit(ctx, args, 'error', message);
      return errorResult(`tool '${name}' raised: ${message}`);
    }

    emitAudit(ctx, args, result.isError === true ? 'error' : 'ok', undefined);

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
