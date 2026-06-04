import { createHash } from 'node:crypto';
import type { TaskStatus } from '../state/types.js';

/**
 * Phase 8B — pure Obsidian task-line parser. Zero fs, zero deps beyond
 * `node:crypto`. Mirrors how the connector keeps all I/O behind a seam:
 * this module is the testable core that turns a raw markdown line into a
 * structured task, classifies its status character, extracts metadata, and
 * (for writeback) flips the checkbox in place.
 *
 * The task-line grammar is the documented Obsidian Tasks-plugin shape:
 *
 *   ^(indent)(list-marker) [(status-char)] (rest)
 *
 * - indent: leading whitespace + blockquote `>` markers (nested / quoted tasks)
 * - list-marker: `-`, `*`, `+`, or an ordered marker (`1.` / `1)`)
 * - status-char: exactly ONE character between the brackets (Tasks rejects
 *   multi-char symbols), e.g. ` `, `x`, `/`, `-`, `>`, `?`
 * - rest: the description plus all trailing emoji / Dataview metadata
 *
 * We hand-roll the regex (rather than pulling a markdown AST) for the same
 * reasons `src/droids/parse.ts` hand-rolls its frontmatter parser: a markdown
 * AST (remark/mdast) only understands `[ ]` / `[x]` and treats custom status
 * chars (`[/]`, `[-]`) as plain text — exactly the cases we care about.
 */

/** The single-line task grammar. Group 1 indent, 2 marker, 3 status char, 4 rest. */
const TASK_LINE_REGEX = /^([\s>]*)([-*+]|\d+[.)]) +\[(.)\] *(.*)$/u;

/** Trailing markdown block id: `^abc-123` at end of line. */
const BLOCK_ID_REGEX = /\s\^([A-Za-z0-9][A-Za-z0-9-]*)\s*$/u;

/** Obsidian Tasks `🆔 id` field — the most stable task identity, when present. */
const TASKS_ID_REGEX = /🆔\s*([A-Za-z0-9]+)/u;

/** Inline tags (`#foo`) and Dataview fields (`[key:: value]`) for stripping. */
const INLINE_TAG_REGEX = /(^|\s)#[^\s#]+/gu;
/** Non-global on purpose — used for `.test`/`.exec`; `/g` makes those stateful. */
const DATAVIEW_FIELD_REGEX = /\[[A-Za-z0-9_-]+::[^\]]*\]/u;

/** Tasks-plugin priority signifiers → integer (higher = sooner). Normal = 0. */
const PRIORITY_EMOJI_TO_INT: ReadonlyArray<readonly [string, number]> = [
  ['🔺', 3], // highest
  ['⏫', 2], // high
  ['🔼', 1], // medium
  ['🔽', -1], // low
  ['⏬', -2], // lowest
];

/** Dataview `[priority:: high]` words → integer (parallels the emoji map). */
const PRIORITY_WORD_TO_INT: Record<string, number> = {
  highest: 3,
  high: 2,
  medium: 1,
  normal: 0,
  none: 0,
  low: -1,
  lowest: -2,
};

/**
 * Every emoji the Tasks plugin uses as a metadata signifier. Used to strip
 * metadata from the description tail and to detect the emoji format. Dates
 * are `YYYY-MM-DD`; recurrence / on-completion carry free text.
 */
const METADATA_EMOJI = [
  '📅',
  '⏳',
  '🛫',
  '➕',
  '✅',
  '❌',
  '🔁',
  '🏁',
  '🔺',
  '⏫',
  '🔼',
  '🔽',
  '⏬',
  '🆔',
  '⛔',
] as const;

export type TaskFormat = 'emoji' | 'dataview' | 'auto';

/** How an Obsidian status character maps onto Symphony's task lifecycle. */
export interface StatusClassification {
  /** The Symphony status this char imports as (when not skipped). */
  readonly status: TaskStatus;
  /**
   * Terminal-in-Obsidian: `[x]` / `[X]` (done) and `[-]` (cancelled). The
   * sync skips these — don't import already-finished work (mirrors 8A's
   * "skip pages already in a terminal Notion status").
   */
  readonly terminal: boolean;
}

/**
 * Default Obsidian status-char → Symphony classification. Conventions follow
 * the Tasks-plugin community defaults; users can override via config maps.
 * Unknown chars are treated as an open `pending` task (NOT skipped) so a
 * custom `[>]` / `[?]` line still imports.
 */
const DEFAULT_STATUS_MAP: Record<string, StatusClassification> = {
  ' ': { status: 'pending', terminal: false },
  '/': { status: 'in_progress', terminal: false },
  '>': { status: 'pending', terminal: false }, // forwarded / deferred
  '?': { status: 'pending', terminal: false }, // question
  '!': { status: 'pending', terminal: false }, // important
  x: { status: 'completed', terminal: true },
  X: { status: 'completed', terminal: true },
  '-': { status: 'cancelled', terminal: true },
};

/** A task line parsed out of a markdown file (pre-routing). */
export interface ParsedTask {
  /** Raw status character between the brackets. */
  readonly statusChar: string;
  /** Mapped Symphony status. */
  readonly status: TaskStatus;
  /** Terminal-in-Obsidian (done/cancelled) — the sync skips these. */
  readonly terminal: boolean;
  /** Cleaned description (checkbox, metadata, tags, block id stripped). */
  readonly description: string;
  /** Integer priority (0 when no priority signifier). */
  readonly priority: number;
  /**
   * Stable locator within the file (precedence: Tasks `🆔 id` →
   * `^blockid` → content hash). Combined with the file path it forms the
   * external-link id used for dedup + writeback.
   */
  readonly locator: string;
}

/**
 * Classify a single status character against the (optionally user-extended)
 * status map. The map is matched case-sensitively for the char itself, but
 * `x`/`X` are both seeded. Unknown chars → open `pending`, non-terminal.
 */
export function classifyStatusChar(
  statusChar: string,
  overrides?: Record<string, StatusClassification>,
): StatusClassification {
  const map = overrides ?? DEFAULT_STATUS_MAP;
  return map[statusChar] ?? { status: 'pending', terminal: false };
}

/** The built-in default status map (exported so the connector can extend it). */
export function defaultStatusMap(): Record<string, StatusClassification> {
  return { ...DEFAULT_STATUS_MAP };
}

/**
 * Detect whether a body uses emoji or Dataview task metadata by scanning the
 * first handful of task lines. Returns `'emoji'` / `'dataview'`; defaults to
 * `'emoji'` when neither is present (the more common vault convention).
 */
export function detectTaskFormat(lines: readonly string[]): 'emoji' | 'dataview' {
  let scanned = 0;
  for (const line of lines) {
    const m = TASK_LINE_REGEX.exec(line);
    if (m === null) continue;
    const rest = m[4] ?? '';
    if (METADATA_EMOJI.some((e) => rest.includes(e))) return 'emoji';
    if (DATAVIEW_FIELD_REGEX.test(rest)) return 'dataview';
    scanned += 1;
    if (scanned >= 20) break;
  }
  return 'emoji';
}

/** Extract the integer priority from a task's `rest`, honoring the format. */
function extractPriority(rest: string, format: 'emoji' | 'dataview'): number {
  if (format === 'dataview') {
    const m = /\[priority::\s*([A-Za-z]+)\s*\]/u.exec(rest);
    const word = m?.[1]?.toLowerCase();
    if (word !== undefined && word in PRIORITY_WORD_TO_INT) {
      return PRIORITY_WORD_TO_INT[word] ?? 0;
    }
    return 0;
  }
  for (const [emoji, value] of PRIORITY_EMOJI_TO_INT) {
    if (rest.includes(emoji)) return value;
  }
  return 0;
}

/**
 * Recover a clean human description from a task's `rest`. The Tasks plugin
 * lays metadata out as a trailing run of signifiers (emoji or `[key:: val]`),
 * so the description is the leading text up to the FIRST signifier. We cut
 * there, then drop the block id and inline tags from what remains and collapse
 * whitespace. Used for display and (lowercased) as the content-hash input.
 */
export function cleanDescription(rest: string): string {
  let out = rest;
  // Find the earliest metadata boundary (any signifier emoji or Dataview field).
  let cut = out.length;
  for (const emoji of METADATA_EMOJI) {
    const idx = out.indexOf(emoji);
    if (idx >= 0 && idx < cut) cut = idx;
  }
  const dv = DATAVIEW_FIELD_REGEX.exec(out);
  if (dv !== null && dv.index < cut) cut = dv.index;
  out = out.slice(0, cut);
  // Drop a trailing block id (when there was no metadata to cut before it).
  out = out.replace(BLOCK_ID_REGEX, '');
  // Drop inline tags.
  out = out.replace(INLINE_TAG_REGEX, ' ');
  // Collapse whitespace.
  return out.replace(/\s+/gu, ' ').trim();
}

/** Short, stable content hash of a normalized description. */
function contentHash(description: string): string {
  return createHash('sha256')
    .update(description.toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

/**
 * Compute the in-file locator for a task line's `rest`, with precedence:
 *   1. Tasks `🆔 id`     → `id:<value>`
 *   2. trailing `^block` → `^<value>`
 *   3. content hash      → `h:<16 hex>`
 * The cleaned `description` is passed in to avoid re-cleaning.
 */
export function computeLocator(rest: string, description: string): string {
  const idMatch = TASKS_ID_REGEX.exec(rest);
  if (idMatch !== null) return `id:${idMatch[1]}`;
  const blockMatch = BLOCK_ID_REGEX.exec(rest);
  if (blockMatch !== null) return `^${blockMatch[1]}`;
  return `h:${contentHash(description)}`;
}

export interface ParseLineOptions {
  readonly format: 'emoji' | 'dataview';
  readonly statusMap?: Record<string, StatusClassification>;
}

/**
 * Parse a single line as an Obsidian task. Returns `undefined` for any line
 * that isn't a task (blank, prose, heading, fenced code, plain list item
 * without a checkbox). The caller is responsible for skipping fenced code
 * blocks before calling this (see `parseTasksFromBody`).
 */
export function parseTaskLine(
  line: string,
  opts: ParseLineOptions,
): ParsedTask | undefined {
  const m = TASK_LINE_REGEX.exec(line);
  if (m === null) return undefined;
  const statusChar = m[3] ?? ' ';
  const rest = (m[4] ?? '').trim();
  const classification = classifyStatusChar(statusChar, opts.statusMap);
  const description = cleanDescription(rest);
  const priority = extractPriority(rest, opts.format);
  const locator = computeLocator(rest, description);
  return {
    statusChar,
    status: classification.status,
    terminal: classification.terminal,
    description: description.length > 0 ? description : '(untitled task)',
    priority,
    locator,
  };
}

/** A parsed task plus the 0-based body line index it was found on. */
export interface ParsedTaskWithLine extends ParsedTask {
  readonly lineIndex: number;
}

/**
 * Parse every task line out of a markdown body (frontmatter already removed).
 * Skips fenced code blocks (``` / ~~~) so a `- [ ]` inside an example block
 * isn't imported. `format` is auto-detected when `'auto'`.
 */
export function parseTasksFromBody(
  body: string,
  opts: { format?: TaskFormat; statusMap?: Record<string, StatusClassification> } = {},
): ParsedTaskWithLine[] {
  const lines = body.split(/\r?\n/u);
  const format: 'emoji' | 'dataview' =
    opts.format === undefined || opts.format === 'auto'
      ? detectTaskFormat(lines)
      : opts.format;
  const out: ParsedTaskWithLine[] = [];
  // Disambiguate duplicate locators WITHIN the file: two identical task lines
  // (no 🆔/block id → same content hash) would otherwise collide on one
  // external id, silently dropping the second on sync and making writeback
  // ambiguous. The first keeps the base locator; the Nth gets `:N` appended so
  // every line round-trips to a distinct task (audit M2). The ordinal is stable
  // as long as the order of the identical lines doesn't change — inherently the
  // best achievable for genuinely identical text without a user-supplied id.
  const seen = new Map<string, number>();
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = /^\s*(```+|~~~+)/u.exec(line);
    if (fence !== null) {
      const marker = (fence[1] ?? '')[0] ?? '`';
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;
    const parsed = parseTaskLine(line, {
      format,
      ...(opts.statusMap !== undefined ? { statusMap: opts.statusMap } : {}),
    });
    if (parsed === undefined) continue;
    const n = (seen.get(parsed.locator) ?? 0) + 1;
    seen.set(parsed.locator, n);
    const locator = n > 1 ? `${parsed.locator}:${n}` : parsed.locator;
    out.push({ ...parsed, locator, lineIndex: i });
  }
  return out;
}

/**
 * Index of the first BODY line — i.e. the line after a leading YAML frontmatter
 * block, or 0 when there's none. Matches gray-matter's rule: frontmatter exists
 * only when the file opens with the `---` delimiter; it ends at the next `---`.
 * A missing closing delimiter ⇒ gray-matter sees no frontmatter ⇒ body starts
 * at 0. Lets the writeback path scan exactly the same line set fetch parses
 * (gray-matter's `content`), so a `- [ ]`-shaped line inside frontmatter is
 * never matched/flipped (audit M1).
 */
export function bodyStartLine(lines: readonly string[]): number {
  if (lines.length === 0 || (lines[0] ?? '').trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') return i + 1;
  }
  return 0;
}

/**
 * Rewrite a single task line's status character (and optionally append a
 * `✅ <date>` done stamp). Returns the new line, or `undefined` when the
 * line isn't a task or already carries the target char (idempotent no-op).
 *
 * Preserves indentation, list marker, spacing, and the description verbatim —
 * only the bracketed char (and an appended done date) change.
 */
export function rewriteTaskLineStatus(
  line: string,
  newChar: string,
  opts: { doneDate?: string } = {},
): string | undefined {
  const m = TASK_LINE_REGEX.exec(line);
  if (m === null) return undefined;
  const currentChar = m[3] ?? ' ';
  const rest = m[4] ?? '';
  const alreadyTarget = currentChar === newChar;
  const hasDoneStamp = /✅\s*\d{4}-\d{2}-\d{2}/u.test(rest);
  const wantStamp = opts.doneDate !== undefined && !hasDoneStamp;
  if (alreadyTarget && !wantStamp) return undefined;

  // Rebuild: reuse the original prefix up through the closing bracket so we
  // never disturb indent / marker / inter-token spacing.
  const closeBracketIdx = line.indexOf(']');
  const prefix = line.slice(0, closeBracketIdx - 1); // up to the char slot's `[`
  const afterBracket = line.slice(closeBracketIdx + 1); // includes the space before rest
  let rebuilt = `${prefix}${newChar}]${afterBracket}`;
  if (wantStamp) {
    rebuilt = `${rebuilt.replace(/\s+$/u, '')} ✅ ${opts.doneDate}`;
  }
  return rebuilt;
}
