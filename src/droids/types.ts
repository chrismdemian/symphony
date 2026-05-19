/**
 * Phase 4F — Custom Droids (Factory pattern).
 *
 * A "droid" is a USER- or Symphony-defined worker role expressed as a
 * markdown file with YAML-ish frontmatter:
 *
 * ```markdown
 * ---
 * name: dhh-reviewer
 * model: opus
 * tools_allowed: [read, grep]
 * tools_denied: [bash, edit]
 * ---
 *
 * You are a reviewer in DHH's style. ...
 * ```
 *
 * Project-scoped droids live in `<project>/.symphony/droids/<name>.md`
 * (Phase 4F.1). Bundled droids (e.g. `design-researcher`, Phase 4F.2)
 * ship inside Symphony. A droid becomes a spawnable role:
 * `spawn_worker({ role: "dhh-reviewer", ... })`. A custom droid whose
 * name equals a built-in role (`implementer`, …) SHADOWS the built-in
 * (PLAN.md §4F: "USER can override by naming a custom droid the same").
 *
 * The frontmatter `tools_allowed` / `tools_denied` / `write_paths` are
 * NOT advisory — Phase 4F enforces them with a PreToolUse hook installed
 * into the droid's worktree (`src/droids/fence.ts`). Symphony spawns
 * every worker with `--permission-mode bypassPermissions`, under which
 * Claude Code's own `--allowedTools` / `--disallowedTools` flags are
 * no-ops; a PreToolUse hook fires regardless of permission mode and is
 * therefore the ONLY enforcement that works without changing the
 * regression-locked bypass-permissions spawn contract. See
 * `research/phase-reviews/4f1.md`.
 */

/**
 * Lowercase frontmatter tool token → the canonical Claude Code tool
 * name(s) it gates. The PreToolUse hook receives the real `tool_name`
 * (e.g. `Write`, `Bash`); the droid author writes the friendly token.
 * `edit` deliberately covers every file-mutation tool — a droid that
 * denies `edit` must not be able to slip through `MultiEdit` /
 * `NotebookEdit`. By the same rule (4F.1 audit C1), `task` covers
 * BOTH `Task` (legacy) and `Agent` (Claude Code renamed the subagent
 * tool — official docs: "Agent (previously Task) — Launches a new
 * agent"); without the fanout, a droid that denies `task` would block
 * the legacy name but ALLOW the current `Agent`, exactly the silent
 * bypass the strict alias map exists to prevent.
 *
 * This map is the canonical, finite, security-relevant allow/deny
 * vocabulary. The parser rejects any token not present here (a typo'd
 * `tools_denied: [bashh]` silently denying nothing is a footgun in a
 * permission gate — fail loud instead).
 *
 * Aliases verified against Claude Code docs as of 2026-05-19. On every
 * tool-name change in Claude Code, re-check this map.
 */
export const DROID_TOOL_ALIASES = {
  read: ['Read'],
  write: ['Write'],
  edit: ['Edit', 'MultiEdit', 'NotebookEdit'],
  bash: ['Bash'],
  grep: ['Grep'],
  glob: ['Glob'],
  webfetch: ['WebFetch'],
  websearch: ['WebSearch'],
  task: ['Task', 'Agent'],
  todowrite: ['TodoWrite'],
} as const satisfies Record<string, readonly string[]>;

export type DroidToolToken = keyof typeof DROID_TOOL_ALIASES;

export const DROID_TOOL_TOKENS = Object.keys(
  DROID_TOOL_ALIASES,
) as readonly DroidToolToken[];

/** A parsed, validated droid definition (project-scoped or bundled). */
export interface DroidDefinition {
  /**
   * Spawnable role name. Validated by {@link assertSafeDroidName}: a
   * single clean path segment (`^[a-zA-Z0-9][a-zA-Z0-9_-]*$`) — it is
   * interpolated into the `spawn_worker` role arg and surfaced to the
   * USER, never into a filesystem path or shell.
   */
  readonly name: string;
  /** Optional model override (`opus` / a full model id). */
  readonly model?: string;
  /**
   * Lowercase tool tokens the droid MAY use. Empty/absent ⇒ no
   * allow-restriction (only the deny list applies). When present, it is
   * a strict allowlist — every tool not expanding into this set is
   * blocked by the fence.
   */
  readonly toolsAllowed?: readonly DroidToolToken[];
  /**
   * Lowercase tool tokens the droid may NOT use. Deny always wins over
   * allow (mirrors Claude Code's own deny→ask→allow precedence).
   */
  readonly toolsDenied?: readonly DroidToolToken[];
  /**
   * Worktree-relative path(s)/globs the droid may write to. When
   * present, ANY write tool (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`)
   * targeting a path outside this set — or outside the worktree — is
   * blocked, even if the tool itself is allowed. Absent ⇒ writes are
   * gated only by the tool allow/deny lists (still worktree-confined by
   * the fence).
   */
  readonly writePaths?: readonly string[];
  /** The system-prompt body (everything after the frontmatter fence). */
  readonly body: string;
  /**
   * Provenance for diagnostics: the absolute `.md` path for a
   * project-scoped droid, or `<bundled:NAME>` for a bundled one.
   */
  readonly source: string;
}

/**
 * The canonical (Claude-Code-tool-name) policy derived from a
 * {@link DroidDefinition}, ready to hand to the PreToolUse fence via
 * env vars. Tokens are expanded through {@link DROID_TOOL_ALIASES}.
 */
export interface DroidToolPolicy {
  /** Canonical tool names explicitly allowed (empty ⇒ no allowlist). */
  readonly allowed: readonly string[];
  /** Canonical tool names explicitly denied. */
  readonly denied: readonly string[];
  /** Worktree-relative write allowlist (verbatim from the droid). */
  readonly writePaths: readonly string[];
}

/** Thrown when a droid file's frontmatter/body is malformed. */
export class DroidParseError extends Error {
  constructor(
    message: string,
    public readonly source: string,
  ) {
    super(message);
    this.name = 'DroidParseError';
  }
}

/** Thrown when a droid name fails the {@link assertSafeDroidName} guard. */
export class DroidNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DroidNameError';
  }
}

/**
 * Reject droid names that could collide with shell/fs/control surfaces.
 * The name is interpolated into the `spawn_worker` role argument, the
 * `<project>/.symphony/droids/<name>.md` filename contract, and USER-
 * facing chat — so this is a hard boundary, modeled on
 * `assertSafeSkillId` (`src/skills/paths.ts`). Stricter than skill ids:
 * a droid name is also a role token, so we pin a clean charset rather
 * than only blocking traversal.
 */
export function assertSafeDroidName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 64 ||
    trimmed.includes('\0') ||
    /[\\/]/.test(trimmed) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(trimmed)
  ) {
    throw new DroidNameError(
      `unsafe droid name '${name}' — must match ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ` +
        '(1–64 chars, no separators, leading dot, or traversal).',
    );
  }
  return trimmed;
}

/**
 * Expand a droid's lowercase tool tokens into the canonical Claude Code
 * tool-name policy the fence enforces. De-duplicates and preserves a
 * stable order so the env-var payload is deterministic (test-friendly).
 */
export function resolveDroidToolPolicy(def: DroidDefinition): DroidToolPolicy {
  const expand = (tokens: readonly DroidToolToken[] | undefined): string[] => {
    if (tokens === undefined || tokens.length === 0) return [];
    const out: string[] = [];
    for (const tok of tokens) {
      for (const canonical of DROID_TOOL_ALIASES[tok]) {
        if (!out.includes(canonical)) out.push(canonical);
      }
    }
    return out;
  };
  return {
    allowed: expand(def.toolsAllowed),
    denied: expand(def.toolsDenied),
    writePaths: def.writePaths ?? [],
  };
}
