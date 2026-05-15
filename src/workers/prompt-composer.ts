import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { WorkerRole } from '../orchestrator/types.js';

/**
 * Phase 4A — Worker prompt composer. The worker-side twin of
 * `composeMaestroPrompt` (`src/orchestrator/maestro/prompt-composer.ts`).
 *
 * Loads the frozen v1 artifacts at `research/prompts/`:
 *   - `role-opener-<role>-v1.md`  — role-differentiating opener
 *   - `worker-common-suffix-v1.md` — identity / scope-clamp / reporting contract
 *
 * Concatenates `opener + suffix`, substitutes the 11 documented template
 * variables, then appends the worker's actual task as a delimited
 * `# Your Task` block (AFTER substitution, so a literal `{token}` inside
 * a task brief is never mangled).
 *
 * Phase 4D.1 will decompose these frozen artifacts into composable
 * fragments + a `PromptComposer` class; Phase 4D.2 owns the worktree
 * `CLAUDE.md` injection + `[NEW TASK]` staleness guard + `.git/info/exclude`
 * coordination. 4A deliberately stops at "produce the string + thread it
 * through the existing `cfg.prompt` spawn seam".
 */

/**
 * The 11 template variables documented in
 * `research/prompts/worker-common-suffix-v1.md`. Empty/blank values render
 * as the literal `(none)` so a worker never reads `undefined`. `autonomyTier`
 * is a string (`'1'|'2'|'3'`) mirroring `MaestroPromptVars.autonomyDefault`.
 */
export interface WorkerPromptVars {
  projectName: string;
  worktreePath: string;
  featureIntent: string;
  autonomyTier: '1' | '2' | '3';
  siblingWorkers: string;
  negativeConstraints: string;
  definitionOfDone: string;
  testCmd: string;
  buildCmd: string;
  lintCmd: string;
  previewCmd: string;
}

const WORKER_TEMPLATE_KEY_TO_FIELD: Record<string, keyof WorkerPromptVars> = {
  project_name: 'projectName',
  worktree_path: 'worktreePath',
  feature_intent: 'featureIntent',
  autonomy_tier: 'autonomyTier',
  sibling_workers: 'siblingWorkers',
  negative_constraints: 'negativeConstraints',
  definition_of_done: 'definitionOfDone',
  test_cmd: 'testCmd',
  build_cmd: 'buildCmd',
  lint_cmd: 'lintCmd',
  preview_cmd: 'previewCmd',
};

/**
 * Role → opener filename. Keyed by `WorkerRole` so TypeScript enforces
 * exhaustiveness if the taxonomy grows. Doubles as the role allowlist:
 * a `role` not present here throws before any filesystem access (defends
 * the direct test/integration callers — `spawn_worker`'s zod enum already
 * constrains the MCP boundary).
 */
const ROLE_OPENER_FILES: Record<WorkerRole, string> = {
  implementer: 'role-opener-implementer-v1.md',
  researcher: 'role-opener-researcher-v1.md',
  reviewer: 'role-opener-reviewer-v1.md',
  debugger: 'role-opener-debugger-v1.md',
  planner: 'role-opener-planner-v1.md',
};

const SUFFIX_FILENAME = 'worker-common-suffix-v1.md';
export const SUFFIX_BEGIN_MARKER = '## BEGIN SUFFIX';
export const SUFFIX_END_MARKER = '## END SUFFIX';
const NONE_LITERAL = '(none)';

/** Public view of the role → frozen-opener-filename map (Phase 4D.1). */
export const WORKER_ROLE_OPENER_FILES: Readonly<Record<WorkerRole, string>> =
  ROLE_OPENER_FILES;
export { SUFFIX_FILENAME as WORKER_SUFFIX_FILENAME };

export class WorkerPromptLoadError extends Error {
  constructor(
    message: string,
    public readonly file: string,
  ) {
    super(message);
    this.name = 'WorkerPromptLoadError';
  }
}

/**
 * Resolve the directory holding the frozen worker prompt artifacts.
 *
 * Two shapes (mirrors `resolveMaestroPromptsDir`):
 *  - Source-run (tsx / vitest): files live at repo `research/prompts/`.
 *  - Bundled (tsup): `tsup` `onSuccess` copies `research/prompts/*.md`
 *    → `dist/prompts/` (`tsup.config.ts:38-41`).
 *
 * `here` for this module is `src/workers/`, so the source candidate is
 * two levels up (`workers → src → repo`), one shallower than Maestro's
 * (`maestro → orchestrator → src → repo`). Tests pass `overrideDir` to
 * keep resolution out of the critical path entirely.
 */
export function resolveWorkerPromptsDir(
  moduleUrl: string = import.meta.url,
  overrideDir?: string,
): string {
  if (overrideDir !== undefined) return overrideDir;
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    // src/workers/ → ../../research/prompts (tsx / vitest run)
    path.resolve(here, '..', '..', 'research', 'prompts'),
    // dist/index.js (single-file tsup bundle) → dist/prompts/
    path.resolve(here, 'prompts'),
    // alt bundle layouts
    path.resolve(here, '..', 'prompts'),
    path.resolve(here, '..', '..', 'prompts'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  // Surface every probed path so debug sessions don't chase a phantom
  // (mirrors Maestro composer m6).
  throw new WorkerPromptLoadError(
    `Could not locate worker prompts directory. Tried:\n  - ${candidates.join('\n  - ')}\n` +
      `Pass an explicit \`promptsDir\` override or rebuild via \`pnpm build\` to populate dist/prompts/.`,
    candidates[0]!,
  );
}

/**
 * Compose a worker's full first-message prompt:
 *
 *   <role opener>            (frozen, role-specific)
 *   <common suffix>          (frozen, identity + scope + reporting contract)
 *   ---
 *   # Your Task
 *   <taskDescription>        (Maestro's brief — appended verbatim, NOT substituted)
 *
 * Template variables are substituted across the frozen `opener + suffix`
 * region only. The reviewer opener references `{test_cmd}` / `{build_cmd}`
 * / `{lint_cmd}` (resolved from the same var set), which is why the pass
 * covers the opener and not just the suffix.
 */
/**
 * The frozen, marker-extracted text of a role's opener + the common
 * suffix. This is the ONLY part of composition that touches the
 * filesystem and the ONLY part that throws `WorkerPromptLoadError` —
 * separated from substitution so a caller can VALIDATE the artifacts
 * are present and well-formed BEFORE doing irreversible work.
 * `worker-lifecycle.doSpawn` preflights this ABOVE
 * `worktreeManager.create()` so a broken bundle (missing
 * `dist/prompts/`) or unknown role fast-fails before any worktree is
 * created — no leaked worktree on every spawn.
 */
export interface WorkerPromptArtifacts {
  readonly opener: string;
  readonly suffix: string;
}

/**
 * Resolve + read + marker-extract the role opener and common suffix.
 * Pure given the files on disk; safe to call as a pre-flight check.
 */
export function loadWorkerPromptArtifacts(
  role: WorkerRole,
  options: { promptsDir?: string } = {},
): WorkerPromptArtifacts {
  const openerFilename = ROLE_OPENER_FILES[role];
  if (openerFilename === undefined) {
    throw new WorkerPromptLoadError(
      `unknown worker role '${String(role)}'; expected one of: ${Object.keys(ROLE_OPENER_FILES).join(', ')}`,
      '',
    );
  }

  const dir = resolveWorkerPromptsDir(import.meta.url, options.promptsDir);
  const openerFile = path.join(dir, openerFilename);
  const suffixFile = path.join(dir, SUFFIX_FILENAME);

  return {
    opener: extractAfterFirstHr(readArtifact(openerFile), openerFile),
    suffix: extractBetween(
      readArtifact(suffixFile),
      SUFFIX_BEGIN_MARKER,
      SUFFIX_END_MARKER,
      suffixFile,
    ),
  };
}

export function composeWorkerPrompt(
  role: WorkerRole,
  taskDescription: string,
  vars: WorkerPromptVars,
  options: { promptsDir?: string; preloaded?: WorkerPromptArtifacts } = {},
): string {
  // Reuse caller-validated artifacts when provided: avoids a second
  // read AND guarantees the artifacts validated at preflight are the
  // exact ones rendered (no TOCTOU between preflight and compose).
  const artifacts = options.preloaded ?? loadWorkerPromptArtifacts(role, options);

  const frozen = `${artifacts.opener}\n${artifacts.suffix}`;
  const substituted = substituteWorkerVars(frozen, vars);

  return `${substituted}\n\n---\n\n# Your Task\n\n${taskDescription.trim()}\n`;
}

function readArtifact(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new WorkerPromptLoadError(
      `failed to read worker prompt artifact at ${file}: ${(err as Error).message}`,
      file,
    );
  }
}

/**
 * Strip everything up to and including the first markdown horizontal rule
 * (`---` on its own line, CRLF-safe). For the role openers this uniformly
 * drops the `# Role Opener …` H1 + the `> Prepends to …` meta note that
 * must never reach the worker, keeping `## Your Role: …` onward.
 */
export function extractAfterFirstHr(raw: string, file: string): string {
  const lines = raw.split(/\r?\n/);
  const hrIdx = lines.findIndex((line) => line.trim() === '---');
  if (hrIdx === -1) {
    throw new WorkerPromptLoadError(
      `expected a '---' separator (meta-header fence) in ${file}`,
      file,
    );
  }
  return lines.slice(hrIdx + 1).join('\n').trim() + '\n';
}

/**
 * Slice the content between `begin` and `end` marker lines, skipping the
 * marker line itself. Byte-for-byte the same logic as the Maestro
 * composer's `extractPromptBody` (CRLF-safe via `indexOf('\n')`).
 */
export function extractBetween(
  raw: string,
  begin: string,
  end: string,
  file: string,
): string {
  const beginIdx = raw.indexOf(begin);
  const endIdx = raw.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new WorkerPromptLoadError(
      `expected "${begin}" / "${end}" markers in ${file}; got begin=${beginIdx} end=${endIdx}`,
      file,
    );
  }
  const afterBegin = raw.indexOf('\n', beginIdx);
  if (afterBegin === -1 || afterBegin > endIdx) {
    throw new WorkerPromptLoadError(
      `expected newline after "${begin}" before "${end}" in ${file}`,
      file,
    );
  }
  return raw.slice(afterBegin + 1, endIdx).trimEnd() + '\n';
}

function rawValue(vars: WorkerPromptVars, field: keyof WorkerPromptVars): string {
  const s = String(vars[field]);
  return s.trim().length === 0 ? NONE_LITERAL : s;
}

/**
 * Substitute `{token}` template variables in a worker prompt body (or any
 * fragment thereof). Exported so Phase 4D.1's fragment-based
 * `PromptComposer` reuses the EXACT regex + trim/`(none)` rules — the
 * single source of truth that guarantees fragment-assembled output is
 * byte-identical to the monolith `composeWorkerPrompt` path.
 */
export function substituteWorkerVars(body: string, vars: WorkerPromptVars): string {
  // Match {token_name} where token_name is lowercase + underscores.
  // JSON-shaped braces in the reporting contract (`{` + newline + `"did"`)
  // never match — the class excludes whitespace/quotes. Unknown tokens are
  // left literal so accidental prose braces are untouched.
  return body.replace(/\{([a-z_]+)\}/g, (match, key: string) => {
    const field = WORKER_TEMPLATE_KEY_TO_FIELD[key];
    if (field === undefined) return match;
    return rawValue(vars, field);
  });
}
