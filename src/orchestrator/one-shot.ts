import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { buildWorkerEnv } from '../workers/env.js';
import { resolveClaudePath } from '../workers/resolve.js';
import { ensureClaudeTrust } from '../workers/trust.js';

/**
 * One-shot Claude runner: spawns `claude -p --output-format json <prompt>`,
 * collects stdout, and returns a parsed envelope. Separate from
 * `WorkerManager` — no streaming, no session registry, no lifecycle.
 *
 * Used by `audit_changes` (and later by Phase 4 research-wave aggregation
 * + LLM-generated commit messages). The defensive `parseStructuredResponse`
 * helper ports emdash `PrGenerationService.parseProviderResponse:449-502`.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_TAIL_BYTES = 2 * 1024;

export type OneShotSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface OneShotOptions {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Override the resolved `claude` binary path (tests). */
  readonly claudeBinary?: string;
  /** Merged into the base env built from the allowlist — cannot override blocked keys. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Test seam — inject a custom spawner. */
  readonly spawn?: OneShotSpawnFn;
  /** Config path for ensureClaudeTrust (tests). */
  readonly claudeConfigPath?: string;
}

export interface OneShotResult {
  readonly rawStdout: string;
  /**
   * Envelope-unwrapped text. If stdout was `{ result: "..." }`, this is the
   * `result` field. Otherwise, this equals `rawStdout`.
   */
  readonly text: string;
  readonly sessionId?: string;
  readonly exitCode: number | null;
  /** True when the child was killed via AbortSignal or timeout. */
  readonly signaled: boolean;
  readonly durationMs: number;
  /** Last 2KB of stderr — mirrors Phase 1B stderrTail pattern. */
  readonly stderrTail: string;
}

export type OneShotRunner = (opts: OneShotOptions) => Promise<OneShotResult>;

/** Thrown when Claude exits non-zero with no usable stdout. */
export class OneShotExecutionError extends Error {
  readonly stderrTail: string;
  readonly exitCode: number | null;
  readonly signaled: boolean;
  constructor(
    message: string,
    opts: { stderrTail: string; exitCode: number | null; signaled: boolean },
  ) {
    super(message);
    this.name = 'OneShotExecutionError';
    this.stderrTail = opts.stderrTail;
    this.exitCode = opts.exitCode;
    this.signaled = opts.signaled;
  }
}

interface ParsedEnvelope {
  readonly text: string;
  readonly sessionId?: string;
}

/**
 * Shape of Claude's `--output-format json` stdout:
 *   { "result": "...", "session_id": "...", ... }
 * The `result` field is a string — the model's text output. For audit we
 * expect JSON inside that string; `parseStructuredResponse` extracts it.
 */
export function extractEnvelope(rawStdout: string): ParsedEnvelope {
  const trimmed = rawStdout.replace(/^\uFEFF/, '').trim();
  if (trimmed.length === 0) return { text: rawStdout };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') {
      const asObj = parsed as Record<string, unknown>;
      const resultField = asObj.result;
      const text = typeof resultField === 'string' ? resultField : rawStdout;
      const sid = asObj.session_id;
      return {
        text,
        ...(typeof sid === 'string' && sid.length > 0 ? { sessionId: sid } : {}),
      };
    }
  } catch {
    // Not JSON — return raw.
  }
  return { text: rawStdout };
}

/**
 * Default one-shot runner backed by `child_process.spawn`. Factored out so
 * tests can provide their own implementation.
 */
export const defaultOneShotRunner: OneShotRunner = async (opts) => {
  const spawn = opts.spawn ?? (nodeSpawn as OneShotSpawnFn);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const claudeBinary = opts.claudeBinary ?? resolveClaudePath(undefined);

  const trustResult = ensureClaudeTrust(opts.cwd, {
    ...(opts.claudeConfigPath !== undefined ? { configPath: opts.claudeConfigPath } : {}),
    onError: () => {
      /* one-shot is low-stakes; proceed on trust failure */
    },
  });
  void trustResult;

  const { env } = buildWorkerEnv({
    ...(opts.extraEnv !== undefined ? { extraEnv: { ...opts.extraEnv } } : {}),
  });

  const args = ['-p', opts.prompt, '--output-format', 'json', '--strict-mcp-config'];
  if (opts.model !== undefined && opts.model.length > 0) {
    args.push('--model', opts.model);
  }

  const spawnOptions: SpawnOptions = {
    cwd: opts.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(process.platform === 'win32' ? { shell: false } : {}),
  };

  const start = Date.now();
  const child = spawn(claudeBinary, args, spawnOptions);

  let stdout = '';
  let stderr = '';
  let signaled = false;

  const appendStderr = (chunk: string): void => {
    stderr += chunk;
    if (stderr.length > STDERR_TAIL_BYTES * 4) {
      stderr = stderr.slice(-STDERR_TAIL_BYTES * 4);
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    appendStderr(chunk.toString('utf8'));
  });

  const timeoutHandle = setTimeout(() => {
    signaled = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // best effort
    }
  }, timeoutMs);

  let abortHandler: (() => void) | undefined;
  if (opts.signal !== undefined) {
    if (opts.signal.aborted) {
      signaled = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // best effort
      }
    } else {
      abortHandler = () => {
        signaled = true;
        try {
          child.kill('SIGTERM');
        } catch {
          // best effort
        }
      };
      opts.signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  const exitInfo = await new Promise<{ code: number | null; signalName: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        if (abortHandler !== undefined && opts.signal !== undefined) {
          opts.signal.removeEventListener('abort', abortHandler);
        }
        reject(err);
      });
      child.on('close', (code, sig) => {
        clearTimeout(timeoutHandle);
        if (abortHandler !== undefined && opts.signal !== undefined) {
          opts.signal.removeEventListener('abort', abortHandler);
        }
        resolve({ code, signalName: sig });
      });
    },
  );

  const durationMs = Date.now() - start;
  const stderrTail = stderr.slice(-STDERR_TAIL_BYTES);
  const envelope = extractEnvelope(stdout);

  if (
    (exitInfo.code !== 0 || signaled) &&
    stdout.trim().length === 0
  ) {
    throw new OneShotExecutionError(
      `claude -p exited with code ${exitInfo.code ?? 'null'}${
        signaled ? ' (signaled)' : ''
      }: ${stderrTail.split(/\r?\n/).slice(-5).join(' | ').trim() || 'no stderr'}`,
      {
        stderrTail,
        exitCode: exitInfo.code,
        signaled,
      },
    );
  }

  return {
    rawStdout: stdout,
    text: envelope.text,
    ...(envelope.sessionId !== undefined ? { sessionId: envelope.sessionId } : {}),
    exitCode: exitInfo.code,
    signaled,
    durationMs,
    stderrTail,
  };
};

// ---------------------------------------------------------------------------
// Defensive structured-response parser
//
// Direct port of emdash `PrGenerationService.parseProviderResponse`
// (research/repos/emdash/.../PrGenerationService.ts:449-502). Handles: BOM,
// ANSI escapes, envelope unwrap, markdown fences, key-order variations,
// greedy fallback, doubled newline escapes.
// ---------------------------------------------------------------------------

export interface ParseStructuredResponseOptions {
  /** Keys that MUST be present in the parsed object (truthy) for success. */
  readonly requiredFields?: readonly string[];
}

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function parseStructuredResponse<T = unknown>(
  text: string,
  options: ParseStructuredResponseOptions = {},
): T | null {
  try {
    let s = text.replace(/^\uFEFF/, '');
    s = s.replace(ANSI_PATTERN, '');

    // Envelope unwrap: `{ result: "..." }` from `--output-format json`.
    try {
      const envelope: unknown = JSON.parse(s);
      if (envelope !== null && typeof envelope === 'object') {
        const e = envelope as Record<string, unknown>;
        if (typeof e.result === 'string') s = e.result;
      }
    } catch {
      // Not a wrapping envelope — continue with raw text.
    }

    // Strip markdown fences ``` or ```json.
    s = s.replace(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g, '$1');

    const requiredFields = options.requiredFields ?? [];
    let jsonStr: string | undefined;

    if (requiredFields.length >= 2) {
      const [a, b] = requiredFields;
      const esc = (k: string): string => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const forward = new RegExp(
        `\\{[^{}]*"${esc(a as string)}"[^{}]*"${esc(b as string)}"[^{}]*\\}`,
        's',
      );
      const reversed = new RegExp(
        `\\{[^{}]*"${esc(b as string)}"[^{}]*"${esc(a as string)}"[^{}]*\\}`,
        's',
      );
      jsonStr = s.match(forward)?.[0] ?? s.match(reversed)?.[0];
    }

    if (jsonStr === undefined) {
      jsonStr = s.match(/\{[\s\S]*\}/)?.[0];
    }

    if (jsonStr === undefined) return null;

    const parsed: unknown = JSON.parse(jsonStr);
    if (parsed === null || typeof parsed !== 'object') return null;
    const asRecord = parsed as Record<string, unknown>;
    for (const field of requiredFields) {
      if (asRecord[field] === undefined) return null;
    }

    return normalizeStringFields(asRecord) as T;
  } catch {
    return null;
  }
}

/** Convert `\\n` literal escapes to real newlines, mirroring emdash port. */
function normalizeStringFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      let s = value;
      if (s.includes('\\n')) s = s.replace(/\\n/g, '\n');
      s = s.replace(/\\\\n/g, '\n');
      out[key] = s;
    } else {
      out[key] = value;
    }
  }
  return out;
}
