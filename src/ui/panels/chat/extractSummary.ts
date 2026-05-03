import stripAnsi from 'strip-ansi';

/**
 * Pure tool-input summarizer + tool-result formatter.
 *
 * Given a Symphony MCP tool's `name` + `input`, produce a single short
 * line that fits inside a chat bubble — file path, command, query, etc.
 * The summary is a *hint* (you'll see "▸ list_workers …" on tools with
 * no canonical summary field), not a full input dump.
 *
 * Tool result content is ANSI-stripped (Maestro forwards raw stream-json
 * which can carry colored output from the tool runner) and truncated at
 * 1500 bytes — a long-tail limit, not a render cap. Bubble layout still
 * has to fit within the panel width; bubble-level wrapping is the
 * renderer's job.
 *
 * Centralizing this makes the visual frames + tests deterministic; one
 * extractor, one truncator, one ANSI strip.
 */

/**
 * Priority ordered list of input fields to inspect when composing the
 * summary. Matches the conventions across Symphony's MCP tools and
 * common Claude Code tool shapes.
 */
const SUMMARY_KEYS = [
  'file_path',
  'path',
  'command',
  'pattern',
  'query',
  'prompt',
] as const;

/** Max characters of the value portion of the summary line. */
const VALUE_CHAR_BUDGET = 60;

/** Max bytes of tool result content shown inline. */
export const RESULT_CHAR_BUDGET = 1500;
/** Max lines of tool result content shown inline. */
export const RESULT_LINE_BUDGET = 12;

/**
 * Returns a one-line summary of the tool input. Empty string when no
 * canonical key is present and no fallback is meaningful — the caller
 * should render just the tool name in that case.
 */
export function extractToolSummary(input: Record<string, unknown>): string {
  for (const key of SUMMARY_KEYS) {
    const raw = input[key];
    // Audit M2: explicit null check — `typeof null === 'object'` so the
    // `typeof raw === 'string'` test already excludes null values, but
    // documenting the intent here keeps future maintainers from asking.
    // Non-string canonical fields (null, numbers, objects) fall through
    // to the JSON fallback rather than being inlined as JSON noise.
    if (typeof raw === 'string' && raw.length > 0) {
      return clamp(raw, VALUE_CHAR_BUDGET);
    }
  }
  // Fallback: compact JSON of the whole input. Skipped for empty objects
  // and inputs that contain ONLY null / undefined canonical fields —
  // emitting `{"file_path":null}` is uglier than just rendering the
  // bare tool name.
  if (hasOnlyNullishCanonicalFields(input)) return '';
  try {
    const json = JSON.stringify(input);
    if (json === '{}' || json === undefined) return '';
    return clamp(json, VALUE_CHAR_BUDGET);
  } catch {
    // Circular / non-JSON-serializable — should never happen for tool
    // inputs, but stay defensive.
    return '';
  }
}

/**
 * True when `input` is non-empty BUT every canonical SUMMARY_KEYS value
 * is null/undefined and there are no other non-null fields. The bare
 * tool-name header is a better UX than a JSON-noise summary.
 */
function hasOnlyNullishCanonicalFields(input: Record<string, unknown>): boolean {
  const entries = Object.entries(input);
  if (entries.length === 0) return false;
  for (const [key, value] of entries) {
    if (value !== null && value !== undefined) return false;
    if (!(SUMMARY_KEYS as readonly string[]).includes(key)) return false;
  }
  return true;
}

/**
 * ANSI-stripped, truncated tool result content. Returns the empty
 * string when the content is empty after stripping.
 *
 * Two budgets enforced (audit M4):
 *  - char count: clamps at `RESULT_CHAR_BUDGET` (1500) with `…` suffix
 *  - line count: clamps at `RESULT_LINE_BUDGET` (12) with a trailing
 *    `… N more lines` summary so a single tall tool result can't
 *    dominate the chat viewport. Phase 3F will introduce inline
 *    expand/collapse to view the full body.
 */
export function formatToolResult(content: string): string {
  const stripped = stripAnsi(content).replace(/\r\n/g, '\n');
  if (stripped.length === 0) return '';

  const charClamped =
    stripped.length <= RESULT_CHAR_BUDGET
      ? stripped
      : stripped.slice(0, RESULT_CHAR_BUDGET - 1) + '…';

  const lines = charClamped.split('\n');
  if (lines.length <= RESULT_LINE_BUDGET) return charClamped;

  const head = lines.slice(0, RESULT_LINE_BUDGET);
  const more = lines.length - RESULT_LINE_BUDGET;
  return [...head, `… ${more} more line${more === 1 ? '' : 's'}`].join('\n');
}

function clamp(text: string, max: number): string {
  // Collapse interior newlines to a single space so a `command` like
  // `git\nstatus\n` doesn't blow the summary line. Tool *results* keep
  // their newlines; only inputs are flattened.
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + '…';
}
