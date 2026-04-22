import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Derive a stable UUID v4 from an arbitrary string via SHA-256.
 * Same input → same UUID every time. Ported from emdash `ptyManager.ts:340-348`.
 */
export function deterministicSessionUuid(input: string): string {
  const hash = createHash('sha256').update(input).digest();
  // Set version 4 bits (per RFC 4122)
  hash[6] = (hash[6]! & 0x0f) | 0x40;
  // Set variant bits
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Claude Code encodes project directory paths into its local storage by
 * replacing `:`, `\`, and `/` with `-`. This must match the format Claude
 * itself uses to store `<uuid>.jsonl` under `~/.claude/projects/<encoded>/`.
 */
export function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/[:\\/]/g, '-');
}

export interface ResumeValidationInput {
  sessionId: string;
  cwd: string;
  home?: string;
}

export type ResumeValidation =
  | { ok: true; sessionFile: string }
  | { ok: false; reason: 'missing' | 'empty_session_id' | 'empty_cwd' | 'not_a_file' };

export function validateResumeSession(input: ResumeValidationInput): ResumeValidation {
  if (input.sessionId.length === 0) return { ok: false, reason: 'empty_session_id' };
  if (input.cwd.length === 0) return { ok: false, reason: 'empty_cwd' };
  const home = input.home ?? homedir();
  const encoded = encodeCwdForClaudeProjects(input.cwd);
  const sessionFile = join(home, '.claude', 'projects', encoded, `${input.sessionId}.jsonl`);
  if (!existsSync(sessionFile)) return { ok: false, reason: 'missing' };
  try {
    const stats = statSync(sessionFile);
    if (!stats.isFile()) return { ok: false, reason: 'not_a_file' };
  } catch {
    return { ok: false, reason: 'missing' };
  }
  return { ok: true, sessionFile };
}
