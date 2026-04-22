import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, filterCustomArgs, BLOCKED_ARG_FLAGS } from '../../src/workers/args.js';
import type { WorkerConfig } from '../../src/workers/types.js';

const baseCfg: WorkerConfig = {
  id: 'w-1',
  cwd: '/tmp/x',
  prompt: 'hi',
};

describe('buildClaudeArgs — hardcoded lock-in', () => {
  it('emits all protocol-critical flags in order', () => {
    const { args } = buildClaudeArgs({ cfg: baseCfg });
    expect(args.slice(0, 9)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--verbose',
      '--strict-mcp-config',
      '--permission-mode',
      'bypassPermissions',
    ]);
  });

  it('omits optional flags when unset', () => {
    const { args } = buildClaudeArgs({ cfg: baseCfg });
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('--append-system-prompt');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--session-id');
  });

  it('appends --mcp-config when provided', () => {
    const { args } = buildClaudeArgs({
      cfg: { ...baseCfg, mcpConfigPath: '/etc/mcp.json' },
    });
    const i = args.indexOf('--mcp-config');
    expect(i).toBeGreaterThan(0);
    expect(args[i + 1]).toBe('/etc/mcp.json');
  });

  it('appends --model, --max-turns, --append-system-prompt', () => {
    const { args } = buildClaudeArgs({
      cfg: {
        ...baseCfg,
        model: 'opus',
        maxTurns: 5,
        appendSystemPrompt: 'you are a tester',
      },
    });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args).toContain('--max-turns');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('5');
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('you are a tester');
  });

  it('omits --max-turns when value is 0 (sentinel for unset)', () => {
    const { args } = buildClaudeArgs({ cfg: { ...baseCfg, maxTurns: 0 } });
    expect(args).not.toContain('--max-turns');
  });

  it('adds --resume with uuid for resume strategy', () => {
    const { args, sessionStrategy, sessionUuid } = buildClaudeArgs({
      cfg: baseCfg,
      sessionArg: { kind: 'resume', uuid: 'abc-123' },
    });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('abc-123');
    expect(args).not.toContain('--session-id');
    expect(sessionStrategy).toBe('resume');
    expect(sessionUuid).toBe('abc-123');
  });

  it('adds --session-id with uuid for new strategy', () => {
    const { args, sessionStrategy } = buildClaudeArgs({
      cfg: baseCfg,
      sessionArg: { kind: 'new', uuid: 'uuid-xyz' },
    });
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('uuid-xyz');
    expect(args).not.toContain('--resume');
    expect(sessionStrategy).toBe('new');
  });

  it('passes filtered extraArgs through after hardcoded flags', () => {
    const { args } = buildClaudeArgs({
      cfg: { ...baseCfg, extraArgs: ['--custom', 'yes', '--another=1'] },
    });
    expect(args).toContain('--custom');
    expect(args).toContain('yes');
    expect(args).toContain('--another=1');
  });

  it('reports filtered blocked args via .filtered', () => {
    const result = buildClaudeArgs({
      cfg: { ...baseCfg, extraArgs: ['--output-format', 'text', '--keep'] },
    });
    expect(result.filtered).toEqual(['--output-format', 'text']);
    expect(result.args).toContain('--keep');
  });
});

describe('filterCustomArgs', () => {
  it.each(BLOCKED_ARG_FLAGS)('blocks %s as standalone or with value', (flag) => {
    const { kept, filtered } = filterCustomArgs([flag, 'maybe-value']);
    expect(kept).not.toContain(flag);
    expect(filtered).toContain(flag);
  });

  it('blocks both "flag value" and "flag=value" forms', () => {
    expect(filterCustomArgs(['--output-format', 'text']).kept).toEqual([]);
    expect(filterCustomArgs(['--output-format=text']).kept).toEqual([]);
    expect(filterCustomArgs(['--resume', 'uuid']).kept).toEqual([]);
    expect(filterCustomArgs(['--resume=uuid']).kept).toEqual([]);
  });

  it('treats standalone blocked flag as not consuming next arg', () => {
    const { kept, filtered } = filterCustomArgs(['-p', '--harmless']);
    expect(filtered).toEqual(['-p']);
    expect(kept).toEqual(['--harmless']);
  });

  it('preserves unknown flags unchanged', () => {
    const { kept, filtered } = filterCustomArgs(['--debug', '--foo=bar', 'positional']);
    expect(kept).toEqual(['--debug', '--foo=bar', 'positional']);
    expect(filtered).toEqual([]);
  });

  it('returns empty results for empty input', () => {
    expect(filterCustomArgs([])).toEqual({ kept: [], filtered: [] });
  });
});
