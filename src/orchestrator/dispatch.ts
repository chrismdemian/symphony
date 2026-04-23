import { CapabilityDeniedError, SafetyGuardError } from './types.js';
import type { CapabilityFlag, DispatchContext, ToolScope } from './types.js';
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

export function wrapToolHandler<TArgs extends Record<string, unknown>>(
  opts: WrapToolHandlerOptions<TArgs>,
): (args: TArgs, signal?: AbortSignal) => Promise<ToolHandlerResult> {
  const { name, scope, capabilities, handler, safety, capabilityEvaluator, getContext } = opts;

  return async (args: TArgs, signal?: AbortSignal): Promise<ToolHandlerResult> => {
    const base = getContext();
    const ctx: DispatchContext = signal ? { ...base, signal } : base;

    if (scope !== 'both' && scope !== ctx.mode) {
      return errorResult(`tool '${name}' is not available in ${ctx.mode} mode`);
    }

    const decision = capabilityEvaluator.evaluate(capabilities, ctx);
    if (!decision.allow) {
      return errorResult(`tool '${name}' denied by capability policy: ${decision.reason ?? 'unspecified'}`);
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
