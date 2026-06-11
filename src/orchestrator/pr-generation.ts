import {
  changedFilesInRange,
  commitSubjectsInRange,
  diffStatRange,
  isAbortError,
  refExists,
  workingTreeDiffStat,
} from './git-ops.js';
import {
  defaultOneShotRunner,
  parseStructuredResponse,
  type OneShotRunner,
} from './one-shot.js';

/**
 * Phase 3O.2 — PR title + description generation.
 *
 * Direct adaptation of emdash `PrGenerationService` (research/repos/emdash/
 * src/main/services/PrGenerationService.ts). Symphony differences:
 *   - The one-shot Claude invocation reuses `defaultOneShotRunner` +
 *     `parseStructuredResponse` (already ported in 2A.4b — the parser IS
 *     emdash's `parseProviderResponse`). No re-port.
 *   - Single provider (`claude -p`); emdash tries a provider chain.
 *   - Range diffs use the merge-base (`base...HEAD`) so parent-branch
 *     commits made after the worker started don't pollute the context
 *     (the same 3J reasoning that drives `mergeBase`).
 *
 * The generator NEVER throws on git/LLM failure — it degrades:
 *   LLM (parse, retry once) → heuristic (commits + files) → fallback.
 * Only `AbortError` propagates (cooperative cancellation).
 */

export interface GeneratedPrContent {
  readonly title: string;
  readonly description: string;
  /** Which tier produced the content — surfaced in the tool result for transparency. */
  readonly source: 'llm' | 'heuristic' | 'fallback';
}

export interface PrGitContext {
  /** Diffstat summary (NOT the full patch — keeps the prompt small). */
  readonly diff: string;
  /** Commit subjects on this branch, newest first. */
  readonly commits: readonly string[];
  readonly changedFiles: readonly string[];
  /** The ref we diffed against, or null when we fell back to the working tree. */
  readonly baseRef: string | null;
}

export interface GeneratePrContentInput {
  readonly worktreePath: string;
  /**
   * Pre-resolved base ref to diff against (e.g. `origin/master`), or null
   * to use the working-tree diff. Callers resolve via `resolvePrBaseRef`.
   */
  readonly baseRef: string | null;
  /** Model for the one-shot generator. Defaults to project default / claude default. */
  readonly model?: string;
  readonly signal?: AbortSignal;
}

export interface GeneratePrContentDeps {
  /** Test seam — defaults to the real `claude -p --output-format json` runner. */
  readonly oneShotRunner?: OneShotRunner;
}

const ONE_SHOT_MAX_ATTEMPTS = 2; // initial + one retry on parse failure
const PROMPT_DIFF_CHAR_CAP = 2000;

/**
 * Resolve the best ref to diff a PR branch against. Prefers the remote
 * tracking ref (`origin/<base>` — always up to date) over a possibly-stale
 * local branch, then the local branch, then null (caller uses working-tree
 * diff). Mirrors emdash's remote-first preference (`PrGenerationService.ts:
 * 103-123`).
 */
export async function resolvePrBaseRef(
  worktreePath: string,
  baseBranch: string,
  remote = 'origin',
  signal?: AbortSignal,
): Promise<string | null> {
  const remoteRef = `${remote}/${baseBranch}`;
  if (await refExists(worktreePath, remoteRef, signal)) return remoteRef;
  if (await refExists(worktreePath, baseBranch, signal)) return baseBranch;
  return null;
}

/** Catch non-abort errors, returning a fallback; rethrow `AbortError`. */
async function tolerant<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isAbortError(err)) throw err;
    return fallback;
  }
}

/**
 * Gather diffstat + commit subjects + changed files for the PR branch.
 * Range-based when `baseRef` is set; falls back to the working-tree
 * diffstat when there's no base ref OR the range is empty (e.g. the branch
 * has no commits past the base yet — only uncommitted work).
 */
export async function getPrGitContext(
  worktreePath: string,
  baseRef: string | null,
  signal?: AbortSignal,
): Promise<PrGitContext> {
  if (baseRef !== null) {
    const [diff, commits, changedFiles] = await Promise.all([
      tolerant(diffStatRange(worktreePath, baseRef, signal), ''),
      tolerant(commitSubjectsInRange(worktreePath, baseRef, signal), [] as string[]),
      tolerant(changedFilesInRange(worktreePath, baseRef, signal), [] as string[]),
    ]);
    if (diff.trim().length > 0 || commits.length > 0 || changedFiles.length > 0) {
      return { diff, commits, changedFiles, baseRef };
    }
  }
  const wtDiff = await tolerant(workingTreeDiffStat(worktreePath, signal), '');
  return { diff: wtDiff, commits: [], changedFiles: [], baseRef: null };
}

/**
 * Generate PR content for the branch checked out in `worktreePath`.
 * Pipeline: LLM (one-shot Claude, retry once on parse failure) → heuristic
 * → fallback. Never throws except on `AbortError`.
 */
export async function generatePrContent(
  input: GeneratePrContentInput,
  deps: GeneratePrContentDeps = {},
): Promise<GeneratedPrContent> {
  const runner = deps.oneShotRunner ?? defaultOneShotRunner;

  const ctx = await getPrGitContext(input.worktreePath, input.baseRef, input.signal);

  // No context at all → bare fallback (named after the changed files, if any).
  if (ctx.diff.trim().length === 0 && ctx.commits.length === 0) {
    return generateFallbackContent(ctx.changedFiles);
  }

  const prompt = buildPrGenerationPrompt(ctx.diff, ctx.commits);
  for (let attempt = 0; attempt < ONE_SHOT_MAX_ATTEMPTS; attempt += 1) {
    let text: string;
    try {
      const result = await runner({
        prompt,
        cwd: input.worktreePath,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      text = result.text;
    } catch (err) {
      if (isAbortError(err)) throw err;
      break; // runner failed (non-zero exit / spawn error) — go heuristic
    }

    const parsed = parseStructuredResponse<{ title?: unknown; description?: unknown }>(text, {
      requiredFields: ['title', 'description'],
    });
    if (
      parsed !== null &&
      typeof parsed.title === 'string' &&
      typeof parsed.description === 'string'
    ) {
      const title = capTitle(parsed.title.trim());
      const description = normalizeMarkdown(parsed.description);
      if (title.length > 0 && description.length > 0) {
        return { title, description, source: 'llm' };
      }
    }
    // Process succeeded but output unusable — retry once, then heuristic.
  }

  return generateHeuristicContent(ctx.diff, ctx.commits, ctx.changedFiles);
}

/**
 * Build the one-shot prompt. Port of emdash `buildPrGenerationPrompt`,
 * trimmed to Symphony's single-provider path. The diff is a diffstat, so
 * the 2000-char cap rarely bites; kept for runaway file lists.
 */
export function buildPrGenerationPrompt(
  diff: string,
  commits: readonly string[],
): string {
  const commitContext =
    commits.length > 0
      ? `\n\nCommits:\n${commits.map((c) => `- ${c}`).join('\n')}`
      : '';
  const diffContext = diff
    ? `\n\nDiff summary:\n${diff.substring(0, PROMPT_DIFF_CHAR_CAP)}${
        diff.length > PROMPT_DIFF_CHAR_CAP ? '...' : ''
      }`
    : '';

  return `Generate a concise PR title and description based on these changes:
${commitContext}${diffContext}

Respond with ONLY valid JSON — no markdown fences, no preamble, no explanation. Your entire response must be exactly one JSON object:
{
  "title": "A concise PR title (max 72 chars, use conventional commit format if applicable)",
  "description": "A well-structured markdown description. Use ## for section headers, - for lists, \`code\` for inline code. Use actual newlines (\\n in JSON) for line breaks, not literal backslash-n text. Keep it straightforward and to the point."
}`;
}

const CONVENTIONAL_PREFIX_RE =
  /^(feat|fix|chore|docs|style|refactor|test|perf|ci|build|revert):/i;
const PR_TITLE_MAX = 72;

/** Cap a title at PR_TITLE_MAX chars, appending '...' when truncated. */
function capTitle(title: string): string {
  return title.length > PR_TITLE_MAX ? `${title.slice(0, PR_TITLE_MAX - 3)}...` : title;
}

/**
 * Heuristic PR content from commits + files — used when the LLM call fails
 * or its output won't parse. Never fabricates: title comes from the most
 * recent commit (or a file-pattern inference), description lists the actual
 * commits + files + diffstat. Port of emdash `generateHeuristicContent`.
 */
export function generateHeuristicContent(
  diff: string,
  commits: readonly string[],
  changedFiles: readonly string[],
): GeneratedPrContent {
  let title = 'chore: update code';
  const firstCommit = commits[0];
  if (firstCommit !== undefined) {
    // Strip the conventional prefix, re-add it, THEN cap — emdash caps before
    // re-adding the prefix, which can push the final title past the limit.
    const core = firstCommit.replace(
      /^(feat|fix|chore|docs|style|refactor|test|perf|ci|build|revert):\s*/i,
      '',
    );
    const prefix = CONVENTIONAL_PREFIX_RE.exec(firstCommit)?.[1];
    title = capTitle(
      prefix !== undefined && !core.toLowerCase().startsWith(prefix.toLowerCase())
        ? `${prefix}: ${core}`
        : core,
    );
  } else {
    const mainFile = changedFiles[0];
    if (mainFile !== undefined) {
      const fileName = mainFile.split('/').pop() ?? mainFile;
      const baseName = fileName.replace(/\.[^.]*$/, '');
      if (/test|spec/i.test(fileName)) title = 'test: add tests';
      else if (/fix|bug|error/i.test(fileName)) title = 'fix: resolve issue';
      else if (/feat|feature|add/i.test(fileName)) title = 'feat: add feature';
      else if (/^[A-Z]/.test(baseName)) title = capTitle(`feat: add ${baseName}`);
      else title = capTitle(`chore: update ${baseName.length > 0 ? baseName : fileName}`);
    }
  }

  const { fileCount, insertions, deletions } = parseDiffStat(diff, changedFiles.length);

  const parts: string[] = [];
  if (commits.length > 0) {
    parts.push('## Changes');
    for (const commit of commits) parts.push(`- ${commit}`);
  }

  if (changedFiles.length > 0) {
    const onlyFile = changedFiles[0];
    if (changedFiles.length === 1 && fileCount === 1 && onlyFile !== undefined) {
      parts.push('\n## Summary');
      parts.push(`- Updated \`${onlyFile}\``);
      const lines = formatLineDelta(insertions, deletions);
      if (lines !== null) parts.push(`- ${lines} lines`);
    } else {
      parts.push('\n## Files Changed');
      for (const file of changedFiles.slice(0, 20)) parts.push(`- \`${file}\``);
      if (changedFiles.length > 20) {
        parts.push(`\n... and ${changedFiles.length - 20} more files`);
      }
      pushSummaryStats(parts, fileCount, insertions, deletions);
    }
  } else if (fileCount > 0 || insertions > 0 || deletions > 0) {
    pushSummaryStats(parts, fileCount, insertions, deletions);
  }

  const description = parts.length > 0 ? parts.join('\n') : 'No description available.';
  return { title, description: normalizeMarkdown(description), source: 'heuristic' };
}

/** Bare fallback when there's no usable git context at all. */
export function generateFallbackContent(
  changedFiles: readonly string[],
): GeneratedPrContent {
  const firstFile = changedFiles[0];
  const title =
    firstFile !== undefined
      ? `chore: update ${firstFile.split('/').pop() ?? 'files'}`
      : 'chore: update code';
  const description =
    changedFiles.length > 0
      ? `Updated ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'}.`
      : 'No changes detected.';
  return { title, description, source: 'fallback' };
}

/**
 * Normalize generated markdown: ensure blank line before headers, collapse
 * 3+ blank lines, trim trailing whitespace per line. Port of emdash
 * `normalizeMarkdown`.
 */
export function normalizeMarkdown(text: string): string {
  if (text.length === 0) return text;
  let out = text.replace(/\n(##+ )/g, '\n\n$1');
  out = out.replace(/\n{3,}/g, '\n\n');
  out = out
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
  return out.trim();
}

interface DiffStatTotals {
  fileCount: number;
  insertions: number;
  deletions: number;
}

function parseDiffStat(diff: string, changedFileCount: number): DiffStatTotals {
  let fileCount = 0;
  let insertions = 0;
  let deletions = 0;
  if (diff.length > 0) {
    const m = diff.match(
      /(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertions?\(\+\))?(?:,\s+(\d+)\s+deletions?\(-\))?/,
    );
    if (m !== null) {
      fileCount = toInt(m[1]);
      insertions = toInt(m[2]);
      deletions = toInt(m[3]);
    }
  }
  if (fileCount === 0 && changedFileCount > 0) fileCount = changedFileCount;
  return { fileCount, insertions, deletions };
}

function toInt(v: string | undefined): number {
  if (v === undefined) return 0;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

function formatLineDelta(insertions: number, deletions: number): string | null {
  const parts: string[] = [];
  if (insertions > 0) parts.push(`+${insertions}`);
  if (deletions > 0) parts.push(`-${deletions}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

function pushSummaryStats(
  parts: string[],
  fileCount: number,
  insertions: number,
  deletions: number,
): void {
  if (fileCount === 0 && insertions === 0 && deletions === 0) return;
  parts.push('\n## Summary');
  if (fileCount > 0) parts.push(`- ${fileCount} file${fileCount === 1 ? '' : 's'} changed`);
  const lines = formatLineDelta(insertions, deletions);
  if (lines !== null) parts.push(`- ${lines} lines`);
}
