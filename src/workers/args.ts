import type { WorkerConfig } from './types.js';

type BlockedArgMode = 'with-value' | 'standalone';

const BLOCKED_ARGS = new Map<string, BlockedArgMode>([
  ['-p', 'standalone'],
  ['--output-format', 'with-value'],
  ['--input-format', 'with-value'],
  ['--permission-mode', 'with-value'],
  ['--strict-mcp-config', 'standalone'],
  ['--resume', 'with-value'],
  ['--session-id', 'with-value'],
  ['--mcp-config', 'with-value'],
  ['--verbose', 'standalone'],
]);

export interface BuildArgsResult {
  args: string[];
  sessionStrategy: 'resume' | 'new' | 'none';
  sessionUuid?: string;
  filtered?: string[];
}

export interface BuildArgsInput {
  cfg: WorkerConfig;
  sessionArg?: { kind: 'resume' | 'new'; uuid: string };
}

export function buildClaudeArgs(input: BuildArgsInput): BuildArgsResult {
  const { cfg, sessionArg } = input;
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--permission-mode',
    'bypassPermissions',
  ];

  if (cfg.mcpConfigPath !== undefined && cfg.mcpConfigPath.length > 0) {
    args.push('--mcp-config', cfg.mcpConfigPath);
  }
  if (cfg.model !== undefined && cfg.model.length > 0) {
    args.push('--model', cfg.model);
  }
  if (cfg.maxTurns !== undefined && cfg.maxTurns > 0) {
    args.push('--max-turns', String(cfg.maxTurns));
  }
  if (cfg.appendSystemPrompt !== undefined && cfg.appendSystemPrompt.length > 0) {
    args.push('--append-system-prompt', cfg.appendSystemPrompt);
  }

  let sessionStrategy: 'resume' | 'new' | 'none' = 'none';
  let sessionUuid: string | undefined;
  if (sessionArg) {
    if (sessionArg.kind === 'resume') {
      args.push('--resume', sessionArg.uuid);
      sessionStrategy = 'resume';
    } else {
      args.push('--session-id', sessionArg.uuid);
      sessionStrategy = 'new';
    }
    sessionUuid = sessionArg.uuid;
  }

  const { kept, filtered } = filterCustomArgs(cfg.extraArgs ?? []);
  args.push(...kept);

  const out: BuildArgsResult = { args, sessionStrategy };
  if (sessionUuid !== undefined) out.sessionUuid = sessionUuid;
  if (filtered.length > 0) out.filtered = filtered;
  return out;
}

export interface FilterResult {
  kept: string[];
  filtered: string[];
}

export function filterCustomArgs(args: readonly string[]): FilterResult {
  const kept: string[] = [];
  const filtered: string[] = [];
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      filtered.push(arg);
      skipNext = false;
      continue;
    }
    const eqIdx = arg.indexOf('=');
    const flag = eqIdx > 0 ? arg.slice(0, eqIdx) : arg;
    const inlineValue = eqIdx > 0;
    const mode = BLOCKED_ARGS.get(flag);
    if (mode !== undefined) {
      filtered.push(arg);
      if (mode === 'with-value' && !inlineValue) skipNext = true;
      continue;
    }
    kept.push(arg);
  }
  return { kept, filtered };
}

export const BLOCKED_ARG_FLAGS: readonly string[] = Array.from(BLOCKED_ARGS.keys());
