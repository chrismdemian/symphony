import { createHash } from 'node:crypto';

/**
 * obsidian-source — pure Obsidian task-line parser. A faithful port of
 * Symphony's in-tree `src/integrations/obsidian-parser.ts` (a plugin can't
 * import app internals). Zero fs, zero deps beyond `node:crypto`.
 *
 * The task-line grammar is the documented Obsidian Tasks-plugin shape:
 *
 *   ^(indent)(list-marker) [(status-char)] (rest)
 *
 * We hand-roll the regex (rather than pull a markdown AST) so custom status
 * chars (`[/]`, `[-]`) are honored — an mdast only understands `[ ]` / `[x]`.
 */

export type SymphonyStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

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
  ['🔺', 3],
  ['⏫', 2],
  ['🔼', 1],
  ['🔽', -1],
  ['⏬', -2],
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

/** Every emoji the Tasks plugin uses as a metadata signifier. */
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

export interface StatusClassification {
  readonly status: SymphonyStatus;
  /** Terminal-in-Obsidian: `[x]`/`[X]` (done) and `[-]` (cancelled). */
  readonly terminal: boolean;
}

const DEFAULT_STATUS_MAP: Record<string, StatusClassification> = {
  ' ': { status: 'pending', terminal: false },
  '/': { status: 'in_progress', terminal: false },
  '>': { status: 'pending', terminal: false },
  '?': { status: 'pending', terminal: false },
  '!': { status: 'pending', terminal: false },
  x: { status: 'completed', terminal: true },
  X: { status: 'completed', terminal: true },
  '-': { status: 'cancelled', terminal: true },
};

export interface ParsedTask {
  readonly statusChar: string;
  readonly status: SymphonyStatus;
  readonly terminal: boolean;
  readonly description: string;
  readonly priority: number;
  readonly locator: string;
}

export function classifyStatusChar(
  statusChar: string,
  overrides?: Record<string, StatusClassification>,
): StatusClassification {
  const map = overrides ?? DEFAULT_STATUS_MAP;
  return map[statusChar] ?? { status: 'pending', terminal: false };
}

export function defaultStatusMap(): Record<string, StatusClassification> {
  return { ...DEFAULT_STATUS_MAP };
}

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

export function cleanDescription(rest: string): string {
  let out = rest;
  let cut = out.length;
  for (const emoji of METADATA_EMOJI) {
    const idx = out.indexOf(emoji);
    if (idx >= 0 && idx < cut) cut = idx;
  }
  const dv = DATAVIEW_FIELD_REGEX.exec(out);
  if (dv !== null && dv.index < cut) cut = dv.index;
  out = out.slice(0, cut);
  out = out.replace(BLOCK_ID_REGEX, '');
  out = out.replace(INLINE_TAG_REGEX, ' ');
  return out.replace(/\s+/gu, ' ').trim();
}

function contentHash(description: string): string {
  return createHash('sha256').update(description.toLowerCase()).digest('hex').slice(0, 16);
}

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

export function parseTaskLine(line: string, opts: ParseLineOptions): ParsedTask | undefined {
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

export interface ParsedTaskWithLine extends ParsedTask {
  readonly lineIndex: number;
}

export function parseTasksFromBody(
  body: string,
  opts: { format?: TaskFormat; statusMap?: Record<string, StatusClassification> } = {},
): ParsedTaskWithLine[] {
  const lines = body.split(/\r?\n/u);
  const format: 'emoji' | 'dataview' =
    opts.format === undefined || opts.format === 'auto' ? detectTaskFormat(lines) : opts.format;
  const out: ParsedTaskWithLine[] = [];
  // Disambiguate duplicate locators WITHIN the file (two identical task lines
  // → same content hash). First keeps the base locator; the Nth gets `:N`
  // appended so every line round-trips to a distinct task (8B audit M2).
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
 * Index of the first BODY line — the line after a leading YAML frontmatter
 * block, or 0 when there's none. Matches gray-matter's rule (frontmatter only
 * when line 0 is exactly `---`; ends at the next `---`). Lets writeback scan
 * the same line set fetch parses (8B audit M1).
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
 * `✅ <date>` done stamp). Returns the new line, or `undefined` when the line
 * isn't a task or already carries the target char (idempotent no-op).
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

  const closeBracketIdx = line.indexOf(']');
  const prefix = line.slice(0, closeBracketIdx - 1);
  const afterBracket = line.slice(closeBracketIdx + 1);
  let rebuilt = `${prefix}${newChar}]${afterBracket}`;
  if (wantStamp) {
    rebuilt = `${rebuilt.replace(/\s+$/u, '')} ✅ ${opts.doneDate}`;
  }
  return rebuilt;
}
