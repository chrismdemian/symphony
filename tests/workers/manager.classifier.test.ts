import { describe, it, expect } from 'vitest';
import { classifyExit, type ClassifierInput } from '../../src/workers/manager.js';

function mk(over: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    exitCode: 0,
    signal: null,
    stopIntent: 'none',
    resultSeen: true,
    resultIsError: false,
    ...over,
  };
}

describe('classifyExit', () => {
  it('clean exit with result → completed', () => {
    expect(classifyExit(mk())).toBe('completed');
  });

  it('clean exit without result → failed (CLI crashed pre-result)', () => {
    expect(classifyExit(mk({ resultSeen: false }))).toBe('failed');
  });

  it('non-zero exit → failed', () => {
    expect(classifyExit(mk({ exitCode: 1 }))).toBe('failed');
  });

  it('exit code null with no signal → failed', () => {
    expect(classifyExit(mk({ exitCode: null, resultSeen: false }))).toBe('failed');
  });

  it('result with isError=true overrides clean exit → failed', () => {
    expect(classifyExit(mk({ resultIsError: true }))).toBe('failed');
  });

  it('stopIntent=kill always wins → killed', () => {
    expect(classifyExit(mk({ stopIntent: 'kill', resultSeen: true }))).toBe('killed');
    expect(classifyExit(mk({ stopIntent: 'kill', exitCode: 1 }))).toBe('killed');
    expect(classifyExit(mk({ stopIntent: 'kill', resultIsError: true }))).toBe('killed');
  });

  it('stopIntent=timeout always wins → timeout', () => {
    expect(classifyExit(mk({ stopIntent: 'timeout', resultSeen: true }))).toBe('timeout');
    expect(classifyExit(mk({ stopIntent: 'timeout', exitCode: 1 }))).toBe('timeout');
  });

  it('signaled death without stopIntent → crashed (OOM, SIGSEGV, external SIGKILL)', () => {
    expect(
      classifyExit(mk({ exitCode: null, signal: 'SIGKILL', resultSeen: false })),
    ).toBe('crashed');
    expect(
      classifyExit(mk({ exitCode: null, signal: 'SIGSEGV', resultSeen: false })),
    ).toBe('crashed');
    expect(
      classifyExit(mk({ exitCode: null, signal: 'SIGBUS', resultSeen: false })),
    ).toBe('crashed');
  });

  it('stopIntent takes precedence over signaled death', () => {
    expect(
      classifyExit(mk({ exitCode: null, signal: 'SIGKILL', stopIntent: 'kill' })),
    ).toBe('killed');
    expect(
      classifyExit(mk({ exitCode: null, signal: 'SIGTERM', stopIntent: 'timeout' })),
    ).toBe('timeout');
  });

  it('signal + non-null exitCode (rare) falls through to exit-code classification', () => {
    // If signal is reported alongside a numeric exit code, treat the exit
    // code as authoritative (typical on Windows when kill bubbles through
    // as code 1 with signal null).
    expect(classifyExit(mk({ exitCode: 1, signal: 'SIGTERM', resultSeen: false }))).toBe(
      'failed',
    );
  });

  it('stopIntent=interrupt → interrupted (Phase 3T)', () => {
    expect(classifyExit(mk({ stopIntent: 'interrupt' }))).toBe('interrupted');
    expect(classifyExit(mk({ stopIntent: 'interrupt', resultIsError: true }))).toBe('interrupted');
    expect(classifyExit(mk({ stopIntent: 'interrupt', exitCode: null, signal: 'SIGTERM' }))).toBe(
      'interrupted',
    );
  });
});
