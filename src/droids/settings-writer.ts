import { promises as fsp } from 'node:fs';
import path from 'node:path';

import {
  editJsoncFile,
  parseJsoncObject,
  stripOwnEntriesByMarker,
} from '../utils/jsonc-edit.js';
import { DROID_FENCE_MARKER } from './hook-command.js';

/**
 * Phase 4F.1 — install the PreToolUse fence into a fenced droid's
 * worktree at `<worktree>/.claude/settings.local.json`.
 *
 * Uses the canonical 4D.5 JSONC primitive (`editJsoncFile`) — Claude
 * Code owns this file's format and a user may hand-add hooks/comments;
 * `JSON.parse → stringify` would destroy both. `editJsoncFile` does a
 * minimal, comment-preserving, crash-atomic (tmp+rename) edit. 4F.1 is
 * the first real consumer of this primitive (1B/2C.2 retrofit stays a
 * tracked follow-up — not re-touched here, per 4D scope discipline).
 *
 * Idempotent: a reused worktree (4D.2 sentinel path) may already carry
 * a prior Symphony entry — it is stripped by {@link DROID_FENCE_MARKER}
 * and replaced, never accumulated. User-authored PreToolUse entries are
 * preserved (the marker never appears in them).
 *
 * No mutex (unlike the Maestro Stop-hook installer): a worktree's
 * settings.local.json has a single writer — `doSpawn`, once, before the
 * worker process starts. `.claude/` is already in
 * `DEFAULT_GIT_EXCLUDE_PATTERNS` (written into the worktree's
 * git-common-dir `info/exclude` at create), so this file never dirties
 * the worktree branch.
 */

const SETTINGS_FILENAME = 'settings.local.json';
const DEFAULT_TIMEOUT_SECONDS = 10;

export interface WriteDroidFenceSettingsInput {
  /** Absolute worktree root. */
  readonly worktreePath: string;
  /** The static command from `buildDroidFenceHookCommand()`. */
  readonly fenceCommand: string;
  /** Override the strip-by-marker substring (default fence marker). */
  readonly marker?: string;
  /** Per-call hook timeout in seconds (Claude Code units). */
  readonly timeoutSeconds?: number;
}

interface PreToolUseEntry {
  readonly hooks: ReadonlyArray<{
    readonly type: 'command';
    readonly command: string;
    readonly timeout?: number;
  }>;
}

/** Read the existing `hooks.PreToolUse` array (tolerant; [] if absent). */
async function readExistingPreToolUse(
  settingsPath: string,
): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(settingsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (raw.trim().length === 0) return [];
  // Throws JsoncParseError on a corrupt file — surface it; `doSpawn`
  // fails fast before the worker starts (a mangled settings file is a
  // real problem, not something to silently overwrite).
  const obj = parseJsoncObject(raw, { file: settingsPath });
  const hooks = obj['hooks'];
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return [];
  }
  const pre = (hooks as Record<string, unknown>)['PreToolUse'];
  return Array.isArray(pre) ? pre : [];
}

/**
 * Write/refresh the fence PreToolUse entry. The matcher is omitted so
 * the hook fires for EVERY tool (Claude Code `hooks.md`: empty/omitted
 * matcher = match all) — the tool allow/deny gate must see Bash/Read/…
 * not just write tools; the write-path gate keys off the tool name
 * inside the hook.
 */
export async function writeDroidFenceSettings(
  input: WriteDroidFenceSettingsInput,
): Promise<void> {
  const claudeDir = path.join(input.worktreePath, '.claude');
  const settingsPath = path.join(claudeDir, SETTINGS_FILENAME);
  await fsp.mkdir(claudeDir, { recursive: true });

  const marker = input.marker ?? DROID_FENCE_MARKER;
  const existing = await readExistingPreToolUse(settingsPath);
  const kept = stripOwnEntriesByMarker(existing, marker);

  const entry: PreToolUseEntry = {
    hooks: [
      {
        type: 'command',
        command: input.fenceCommand,
        timeout: input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      },
    ],
  };
  const next = [...kept, entry];

  await editJsoncFile(settingsPath, [
    { path: ['hooks', 'PreToolUse'], value: next },
  ]);
}
