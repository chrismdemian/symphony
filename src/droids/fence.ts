import path from 'node:path';
import { minimatch } from 'minimatch';

/**
 * Phase 4F.1 — the PreToolUse fence decision (PURE).
 *
 * Symphony spawns every worker with `--permission-mode bypassPermissions`
 * (`src/workers/args.ts`), under which Claude Code's `--allowedTools` /
 * `--disallowedTools` are no-ops (the permission layer is skipped
 * entirely). A PreToolUse hook, however, fires under EVERY permission
 * mode including bypass — so it is the only enforcement that delivers
 * the droid `tools_allowed` / `tools_denied` / `write_paths` contract
 * without changing the regression-locked bypass spawn path. This module
 * is the decision; `fence-hook.ts` is the thin stdin/exit shell that
 * Claude Code invokes. Keeping the decision pure makes it exhaustively
 * unit-testable with no process/fs plumbing.
 *
 * Block contract: the hook EXITS 2 with the `reason` on stderr (Claude
 * Code feeds stderr back to the model on exit 2). It must NEVER be
 * wrapped in `|| true` — that gotcha is for NON-blocking hooks; here a
 * non-zero exit IS the block.
 */

/** Tools that mutate files — their target path is write-fenced. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

export interface FenceInput {
  /** PreToolUse `tool_name` (canonical, e.g. `Write`, `Bash`). */
  readonly toolName: string;
  /**
   * Resolved write target for a write tool — `tool_input.file_path`
   * (Write/Edit/MultiEdit) or `tool_input.notebook_path` (NotebookEdit).
   * Absolute when Claude Code resolved it; the hook resolves relatives
   * against the payload `cwd` before calling here.
   */
  readonly filePath?: string;
}

export interface FencePolicy {
  /** Canonical tool names allowed. Empty ⇒ NO allowlist (deny-only mode). */
  readonly allowed: readonly string[];
  /** Canonical tool names denied. Deny always wins over allow. */
  readonly denied: readonly string[];
  /**
   * Worktree-relative path globs the droid may write to (minimatch).
   * Empty ⇒ writes are gated only by the tool lists, still confined to
   * the worktree.
   */
  readonly writePaths: readonly string[];
  /** Absolute worktree root — no write may escape it. */
  readonly worktreeRoot: string;
}

export interface FenceDecision {
  readonly allow: boolean;
  /** Present iff `allow === false`; surfaced to the model via stderr. */
  readonly reason?: string;
}

const ALLOW: FenceDecision = { allow: true };

/** Decide whether a single tool call is permitted for a fenced droid. */
export function evaluateFence(
  input: FenceInput,
  policy: FencePolicy,
): FenceDecision {
  const tool = input.toolName;

  // 1. Tool gate — deny wins, then strict allowlist (if any).
  if (policy.denied.includes(tool)) {
    return {
      allow: false,
      reason: `Symphony droid fence: tool '${tool}' is denied for this droid (tools_denied).`,
    };
  }
  if (policy.allowed.length > 0 && !policy.allowed.includes(tool)) {
    return {
      allow: false,
      reason:
        `Symphony droid fence: tool '${tool}' is not in this droid's allowed set ` +
        `[${policy.allowed.join(', ')}] (tools_allowed).`,
    };
  }

  // 2. Write-path gate — only for file-mutating tools that passed (1).
  if (WRITE_TOOLS.has(tool)) {
    const target = input.filePath;
    if (target === undefined || target.trim().length === 0) {
      return {
        allow: false,
        reason: `Symphony droid fence: ${tool} call has no resolvable target path — refusing (cannot verify write boundary).`,
      };
    }
    const abs = path.resolve(target);
    const rel = path.relative(policy.worktreeRoot, abs);
    const escapesWorktree =
      rel.length === 0 || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    if (escapesWorktree) {
      return {
        allow: false,
        reason:
          `Symphony droid fence: write to '${abs}' is outside the worktree ` +
          `(${policy.worktreeRoot}) — denied.`,
      };
    }
    if (policy.writePaths.length > 0) {
      const relPosix = rel.split(path.sep).join('/');
      const matched = policy.writePaths.some((pattern) =>
        minimatch(relPosix, pattern, { dot: true, nocomment: true }),
      );
      if (!matched) {
        return {
          allow: false,
          reason:
            `Symphony droid fence: write to '${relPosix}' is not in this droid's ` +
            `write_paths [${policy.writePaths.join(', ')}] — denied.`,
        };
      }
    }
  }

  return ALLOW;
}
