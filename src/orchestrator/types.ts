export type ToolMode = 'plan' | 'act';

export type ToolScope = 'plan' | 'act' | 'both';

export type WorkerRole = 'implementer' | 'researcher' | 'reviewer' | 'debugger' | 'planner';

export const WORKER_ROLES: readonly WorkerRole[] = [
  'implementer',
  'researcher',
  'reviewer',
  'debugger',
  'planner',
];

export type CapabilityFlag =
  | 'writes-source'
  | 'external-visible'
  | 'irreversible'
  | 'requires-host-browser-control'
  | 'requires-secrets-read'
  | 'requires-network-egress-uncontrolled';

export type AutonomyTier = 1 | 2 | 3;

export interface DispatchContext {
  mode: ToolMode;
  tier: AutonomyTier;
  awayMode: boolean;
  automationContext: boolean;
  /**
   * Phase 3T — set true by `runtime.interrupt` RPC, cleared by
   * `MaestroProcess.sendUserMessage` after wrapping the user's next
   * message with the `[INTERRUPT NOTICE]` envelope. While true, the
   * dispatch shim short-circuits every ACT-scope tool with a
   * structured error so Maestro's still-streaming turn can't spawn
   * fresh workers between the RPC firing and `turn_completed`.
   * Defaults false; legacy contexts may omit the field (treated as
   * false by the shim).
   */
  interruptPending?: boolean;
  /** Abort signal from the SDK's request-handler controller. Handlers should observe it for cooperative cancellation. */
  signal?: AbortSignal;
}

export interface CapabilityDecision {
  allow: boolean;
  reason?: string;
  /**
   * Phase 3S — informational signal emitted when an allowed tool call
   * crosses a sensitivity threshold for the first time in this session.
   * Surfaced via a TUI toast (independent of the desktop-notifications
   * dispatcher's enabled/TTY/CI gating). Resets on tier change and on
   * server restart. Only emitted when `allow === true`.
   */
  notice?: CapabilityNotice;
}

export interface CapabilityNotice {
  readonly kind: 'first-use';
  readonly tool: string;
  readonly flag: CapabilityFlag;
}

export interface SafetyGuardStats {
  toolCalls: number;
  maxToolCalls: number;
  estimatedTokens: number;
  maxContextTokens: number;
  elapsedSeconds: number;
  toolsUsed: string[];
}

export type SafetyRejectionReason = 'tool-cap' | 'context-cap' | 'loop-detected';

export class SafetyGuardError extends Error {
  readonly reason: SafetyRejectionReason;
  constructor(reason: SafetyRejectionReason, message: string) {
    super(message);
    this.name = 'SafetyGuardError';
    this.reason = reason;
  }
}

export class CapabilityDeniedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'CapabilityDeniedError';
    this.reason = reason;
  }
}
