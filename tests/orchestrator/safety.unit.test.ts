import { describe, expect, it } from 'vitest';
import { AgentSafetyGuard } from '../../src/orchestrator/safety.js';
import { SafetyGuardError } from '../../src/orchestrator/types.js';

describe('AgentSafetyGuard', () => {
  it('uses Omi defaults (25 tool calls, 500K tokens, window 3, 0.8 similarity)', () => {
    const g = new AgentSafetyGuard();
    expect(g.maxToolCalls).toBe(25);
    expect(g.maxContextTokens).toBe(500_000);
    expect(g.loopDetectionWindow).toBe(3);
    expect(g.paramsSimilarityThreshold).toBeCloseTo(0.8);
  });

  it('accepts the first 25 calls and rejects the 26th with tool-cap', () => {
    const g = new AgentSafetyGuard();
    for (let i = 0; i < 25; i += 1) {
      g.validateToolCall('t', { i });
    }
    expect(() => g.validateToolCall('t', { i: 25 })).toThrowError(SafetyGuardError);
    try {
      g.validateToolCall('t', { i: 26 });
    } catch (err) {
      expect(err).toBeInstanceOf(SafetyGuardError);
      expect((err as SafetyGuardError).reason).toBe('tool-cap');
    }
  });

  it('honors a custom maxToolCalls', () => {
    const g = new AgentSafetyGuard({ maxToolCalls: 3 });
    g.validateToolCall('a', { x: 1 });
    g.validateToolCall('b', { x: 2 });
    g.validateToolCall('c', { x: 3 });
    expect(() => g.validateToolCall('d', { x: 4 })).toThrow(/simpler/i);
  });

  it('detects a loop when a 4th identical call arrives after a window of 3', () => {
    const g = new AgentSafetyGuard();
    g.validateToolCall('dup', { q: 'hello' });
    g.validateToolCall('dup', { q: 'hello' });
    g.validateToolCall('dup', { q: 'hello' });
    try {
      g.validateToolCall('dup', { q: 'hello' });
      throw new Error('expected loop rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(SafetyGuardError);
      expect((err as SafetyGuardError).reason).toBe('loop-detected');
    }
  });

  it('allows identical-args across different tool names', () => {
    const g = new AgentSafetyGuard();
    g.validateToolCall('a', { q: 'x' });
    g.validateToolCall('b', { q: 'x' });
    g.validateToolCall('c', { q: 'x' });
    g.validateToolCall('d', { q: 'x' });
    expect(g.getStats().toolCalls).toBe(4);
  });

  it('does not loop-detect when fewer than window calls have been made', () => {
    const g = new AgentSafetyGuard();
    g.validateToolCall('dup', { q: 'hello' });
    g.validateToolCall('dup', { q: 'hello' });
    expect(g.getStats().toolCalls).toBe(2);
  });

  it('treats params at exactly 80% similarity as a loop', () => {
    const g = new AgentSafetyGuard();
    const base = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    g.validateToolCall('dup', base);
    g.validateToolCall('dup', { ...base, e: 999 });
    g.validateToolCall('dup', { ...base, e: 111 });
    try {
      g.validateToolCall('dup', { ...base, e: 1234 });
      throw new Error('expected loop rejection');
    } catch (err) {
      expect((err as SafetyGuardError).reason).toBe('loop-detected');
    }
  });

  it('treats explicit null and missing key as equivalent (Python dict.get parity)', () => {
    const g = new AgentSafetyGuard();
    g.validateToolCall('dup', { q: 'x', filter: null });
    g.validateToolCall('dup', { q: 'x' });
    g.validateToolCall('dup', { q: 'x', filter: null });
    try {
      g.validateToolCall('dup', { q: 'x' });
      throw new Error('expected loop rejection');
    } catch (err) {
      expect((err as SafetyGuardError).reason).toBe('loop-detected');
    }
  });

  it('does not loop-detect at 60% similarity (below 0.8 threshold)', () => {
    const g = new AgentSafetyGuard();
    const base = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    g.validateToolCall('dup', base);
    g.validateToolCall('dup', { a: 1, b: 2, c: 3, d: 99, e: 99 });
    g.validateToolCall('dup', { a: 1, b: 2, c: 3, d: 98, e: 98 });
    g.validateToolCall('dup', { a: 1, b: 2, c: 3, d: 97, e: 97 });
    expect(g.getStats().toolCalls).toBe(4);
  });

  it('throws context-cap when response tokens exceed the budget', () => {
    const g = new AgentSafetyGuard({ maxContextTokens: 10 });
    const little = 'a'.repeat(20); // 5 tokens
    g.checkContextSize(little);
    try {
      g.checkContextSize('b'.repeat(60)); // 15 tokens, total 20 > 10
      throw new Error('expected context rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(SafetyGuardError);
      expect((err as SafetyGuardError).reason).toBe('context-cap');
    }
  });

  it('recordResponseTokens adds to estimate without throwing', () => {
    const g = new AgentSafetyGuard({ maxContextTokens: 1000 });
    g.recordResponseTokens('x'.repeat(100));
    expect(g.getStats().estimatedTokens).toBe(25);
  });

  it('warns when tool-call count crosses 80%', () => {
    const g = new AgentSafetyGuard({ maxToolCalls: 10 });
    for (let i = 0; i < 7; i += 1) g.validateToolCall('t', { i });
    expect(g.shouldWarnUser()).toBeNull();
    g.validateToolCall('t', { i: 8 });
    expect(g.shouldWarnUser()).toMatch(/tool/i);
  });

  it('warns when context size crosses 80%', () => {
    const g = new AgentSafetyGuard({ maxContextTokens: 100 });
    g.recordResponseTokens('x'.repeat(320)); // 80 tokens
    expect(g.shouldWarnUser()).toMatch(/context/i);
  });

  it('reset clears tool count, context, and history', () => {
    const g = new AgentSafetyGuard();
    g.validateToolCall('t', { i: 1 });
    g.validateToolCall('t', { i: 2 });
    g.recordResponseTokens('xxxx');
    g.reset();
    const stats = g.getStats();
    expect(stats.toolCalls).toBe(0);
    expect(stats.estimatedTokens).toBe(0);
    expect(stats.toolsUsed).toEqual([]);
  });

  it('getStats.toolsUsed deduplicates across calls', () => {
    const g = new AgentSafetyGuard();
    g.validateToolCall('alpha', {});
    g.validateToolCall('beta', {});
    g.validateToolCall('alpha', { x: 1 });
    expect([...g.getStats().toolsUsed].sort()).toEqual(['alpha', 'beta']);
  });

  it('elapsed seconds uses injected now()', () => {
    let t = 1000;
    const g = new AgentSafetyGuard({ now: () => t });
    t = 6000; // 5 seconds later
    expect(g.getStats().elapsedSeconds).toBe(5);
  });
});
