import {
  deterministicSessionUuid,
  validateResumeSession,
} from '../../workers/session.js';

/**
 * Mirrors the failure-reason union from `validateResumeSession` without
 * pulling the conditional type into the public surface (TS can't index a
 * generic conditional type by a literal).
 */
export type MaestroSessionFreshReason = 'missing' | 'empty_session_id' | 'empty_cwd' | 'not_a_file';

/**
 * Sentinel input that derives Maestro's session UUID. Keyed off a fixed
 * string (NOT a path) so `$HOME` migrations don't change the UUID. Per
 * Phase 2C plan §session UUID risks: the session FILE moves with cwd
 * encoding, but the UUID itself is forever — `validateResumeSession` is
 * what catches the cwd-mismatch case and falls back to fresh.
 */
const MAESTRO_SESSION_SENTINEL = 'maestro::global';

export const MAESTRO_SESSION_UUID = deterministicSessionUuid(MAESTRO_SESSION_SENTINEL);

export interface ResolveMaestroSessionInput {
  /** Maestro's working directory (`~/.symphony/maestro/` in production). */
  cwd: string;
  /** Override `~/` for tests. */
  home?: string;
}

export interface ResolvedMaestroSession {
  /** The deterministic Maestro session UUID — same on every boot, forever. */
  sessionId: string;
  /**
   * `'resume'` when the corresponding `<home>/.claude/projects/<encoded>/<uuid>.jsonl`
   * exists; `'fresh'` otherwise. The caller threads `sessionId` into
   * `WorkerConfig.sessionId` regardless and sets `onStaleResume:'warn-and-fresh'`
   * so the spawner does the safety check internally.
   */
  mode: 'resume' | 'fresh';
  /** Absolute path to the session file when `mode === 'resume'`. */
  sessionFile?: string;
  /** Reason for `'fresh'` — useful for telemetry / TUI status. */
  freshReason?: MaestroSessionFreshReason;
}

/**
 * Compute Maestro's session UUID + decide whether the next spawn is a resume
 * or a fresh start. Wraps `validateResumeSession` against the sentinel UUID
 * so callers never see Worker-style "missing"/"empty_*" errors leak through.
 */
export function resolveMaestroSession(input: ResolveMaestroSessionInput): ResolvedMaestroSession {
  const validation = validateResumeSession({
    sessionId: MAESTRO_SESSION_UUID,
    cwd: input.cwd,
    ...(input.home !== undefined ? { home: input.home } : {}),
  });
  if (validation.ok) {
    return {
      sessionId: MAESTRO_SESSION_UUID,
      mode: 'resume',
      sessionFile: validation.sessionFile,
    };
  }
  return {
    sessionId: MAESTRO_SESSION_UUID,
    mode: 'fresh',
    freshReason: validation.reason,
  };
}
