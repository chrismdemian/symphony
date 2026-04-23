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
  /** Abort signal from the SDK's request-handler controller. Handlers should observe it for cooperative cancellation. */
  signal?: AbortSignal;
}

export interface CapabilityDecision {
  allow: boolean;
  reason?: string;
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
