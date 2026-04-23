import { SafetyGuardError } from './types.js';
import type { SafetyGuardStats } from './types.js';

export interface SafetyGuardOptions {
  maxToolCalls?: number;
  maxContextTokens?: number;
  loopDetectionWindow?: number;
  paramsSimilarityThreshold?: number;
  now?: () => number;
}

interface ToolCallRecord {
  name: string;
  params: Readonly<Record<string, unknown>>;
  at: number;
}

export class AgentSafetyGuard {
  readonly maxToolCalls: number;
  readonly maxContextTokens: number;
  readonly loopDetectionWindow: number;
  readonly paramsSimilarityThreshold: number;

  private toolCallCount = 0;
  private estimatedTokens = 0;
  private readonly history: ToolCallRecord[] = [];
  private readonly startedAt: number;
  private readonly now: () => number;

  constructor(options: SafetyGuardOptions = {}) {
    this.maxToolCalls = options.maxToolCalls ?? 25;
    this.maxContextTokens = options.maxContextTokens ?? 500_000;
    this.loopDetectionWindow = options.loopDetectionWindow ?? 3;
    this.paramsSimilarityThreshold = options.paramsSimilarityThreshold ?? 0.8;
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
  }

  validateToolCall(name: string, params: Readonly<Record<string, unknown>>): void {
    if (this.toolCallCount >= this.maxToolCalls) {
      throw new SafetyGuardError(
        'tool-cap',
        "I'm having trouble finding all the information you need. Could you try asking a simpler question or breaking this into separate questions?",
      );
    }

    if (this.isLoopDetected(name, params)) {
      throw new SafetyGuardError(
        'loop-detected',
        'I seem to be stuck trying to answer your question. Could you rephrase it in a different way?',
      );
    }

    this.toolCallCount += 1;
    this.history.push({ name, params, at: this.now() });
  }

  checkContextSize(text: string): void {
    const next = this.estimatedTokens + this.estimateTokens(text);
    if (next > this.maxContextTokens) {
      throw new SafetyGuardError(
        'context-cap',
        "That's a lot of information to process at once. Could you narrow down the request or ask about a smaller scope?",
      );
    }
    this.estimatedTokens = next;
  }

  recordResponseTokens(text: string): void {
    this.estimatedTokens += this.estimateTokens(text);
  }

  estimateTokens(text: string): number {
    return Math.floor(text.length / 4);
  }

  shouldWarnUser(): string | null {
    if (this.toolCallCount >= this.maxToolCalls * 0.8) {
      return 'Approaching the tool-call limit for this turn.';
    }
    if (this.estimatedTokens >= this.maxContextTokens * 0.8) {
      return 'Approaching the context size limit for this turn.';
    }
    return null;
  }

  getStats(): SafetyGuardStats {
    const elapsed = Math.max(0, (this.now() - this.startedAt) / 1000);
    const used = new Set<string>();
    for (const call of this.history) used.add(call.name);
    return {
      toolCalls: this.toolCallCount,
      maxToolCalls: this.maxToolCalls,
      estimatedTokens: this.estimatedTokens,
      maxContextTokens: this.maxContextTokens,
      elapsedSeconds: elapsed,
      toolsUsed: [...used],
    };
  }

  reset(): void {
    this.toolCallCount = 0;
    this.estimatedTokens = 0;
    this.history.length = 0;
  }

  private isLoopDetected(name: string, params: Readonly<Record<string, unknown>>): boolean {
    if (this.history.length < this.loopDetectionWindow) return false;
    const recent = this.history.slice(-this.loopDetectionWindow);
    let similar = 0;
    for (const past of recent) {
      if (past.name === name && this.paramsSimilar(past.params, params)) similar += 1;
    }
    return similar >= Math.floor(this.loopDetectionWindow / 2) + 1;
  }

  private paramsSimilar(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    if (keys.size === 0) return true;
    const nullish = (v: unknown): boolean => v === undefined || v === null;
    let matching = 0;
    for (const key of keys) {
      const va = a[key];
      const vb = b[key];
      if (nullish(va) && nullish(vb)) matching += 1;
      else if (this.deepEqual(va, vb)) matching += 1;
    }
    return matching / keys.size >= this.paramsSimilarityThreshold;
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (!this.deepEqual(a[i], b[i])) return false;
      }
      return true;
    }
    if (typeof a === 'object' && typeof b === 'object') {
      const ao = a as Record<string, unknown>;
      const bo = b as Record<string, unknown>;
      const ak = Object.keys(ao);
      const bk = Object.keys(bo);
      if (ak.length !== bk.length) return false;
      for (const k of ak) {
        if (!this.deepEqual(ao[k], bo[k])) return false;
      }
      return true;
    }
    return false;
  }
}
