import os from 'node:os';
import path from 'node:path';

import { symphonyDataDir } from '../utils/config.js';

/**
 * Phase 4D.3 — two-tier skills storage paths.
 *
 * Tier 1 (ephemeral, worker-shaped): `<worktree>/.claude/skills/<name>/`
 * — composed at spawn, no central store, owned by the worker lifecycle;
 * NOT managed here.
 *
 * Tier 2 (persistent, cross-project): the central store below, with OS
 * symlinks from Claude Code's agent dir into it so a source edit is
 * reflected everywhere. Env overrides mirror `SYMPHONY_CONFIG_FILE` /
 * `SYMPHONY_DB_FILE` so tests isolate without touching the real `~`.
 */

export const SYMPHONY_SKILLS_DIR_ENV = 'SYMPHONY_SKILLS_DIR' as const;
export const SYMPHONY_CLAUDE_COMMANDS_DIR_ENV =
  'SYMPHONY_CLAUDE_COMMANDS_DIR' as const;

/** Central persistent skill store — `~/.symphony/skills`. */
export function skillsDir(home?: string): string {
  const override = process.env[SYMPHONY_SKILLS_DIR_ENV]?.trim();
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(symphonyDataDir(home), 'skills');
}

/**
 * Claude Code agent target dir that skill symlinks live in
 * (`~/.claude/commands`). PLAN.md §4D.3 ("symlinks from
 * `~/.claude/commands/<skillId>/` into the central store"). Modeled as
 * one entry of a future multi-agent target set.
 */
export function claudeCommandsDir(home: string = os.homedir()): string {
  const override = process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV]?.trim();
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(home, '.claude', 'commands');
}

/** The single canonical skill manifest filename inside a skill dir. */
export const SKILL_MANIFEST = 'SKILL.md';

/**
 * Reject ids that could escape the store via path traversal or absolute
 * paths. The id is interpolated into BOTH the central dir and the agent
 * symlink path, so this is a hard security boundary, not cosmetic.
 */
export function assertSafeSkillId(id: string): string {
  const trimmed = id.trim();
  if (
    trimmed.length === 0 ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.startsWith('.') ||
    /[\\/]/.test(trimmed) ||
    path.isAbsolute(trimmed) ||
    trimmed.includes('\0')
  ) {
    throw new SkillIdError(
      `unsafe skill id '${id}' — must be a single path segment with no separators, ` +
        'leading dot, or traversal.',
    );
  }
  return trimmed;
}

export class SkillIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillIdError';
  }
}
