/**
 * Phase 5C — Pure formatters for task notes.
 *
 * Used by BOTH the `task_notes` MCP tool (read-path output) and the
 * `task-notes-mirror.ts` disk writer (file content) so the two views
 * are byte-identical. Pure — no IO, no side effects.
 */
import type { TaskNote } from './types.js';

/**
 * Render a `TaskNote.at` (ISO-8601 with `Z` suffix per `task-registry.ts:147`)
 * as `YYYY-MM-DD HH:MM:SS UTC`. Bad/non-parseable input falls back to the
 * raw ISO string so the section header never breaks the markdown structure.
 */
export function formatTaskNoteTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} UTC`;
}

/**
 * Render an ordered list of notes as a single markdown blob. One `##`
 * section per note, header = formatted timestamp, body = note text
 * verbatim. Empty array → empty string. Notes are NOT sorted — caller
 * passes them in display order (typically insertion order from the
 * `tasks.notes` JSON column).
 *
 * Each body is followed by a blank line so adjacent sections render
 * cleanly. The trailing newline is omitted from the final blob (callers
 * append their own when needed).
 */
export function formatNotesAsMarkdown(notes: readonly TaskNote[]): string {
  if (notes.length === 0) return '';
  const sections: string[] = [];
  for (const note of notes) {
    sections.push(`## ${formatTaskNoteTimestamp(note.at)}\n\n${note.text}\n`);
  }
  return sections.join('\n');
}

/**
 * Filter notes whose `at` timestamp is `>= since` (inclusive). When
 * `since` is undefined or fails to parse, returns the full input
 * (drop-philosophy from 3R `coerceAuditFilter`: never hard-fail on a
 * bad client filter — surface the unfiltered view and let the caller
 * detect zero-result mismatch themselves).
 */
export function filterNotesSince(
  notes: readonly TaskNote[],
  since: string | undefined,
): TaskNote[] {
  if (since === undefined) return notes.slice();
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return notes.slice();
  return notes.filter((n) => {
    const noteMs = Date.parse(n.at);
    if (Number.isNaN(noteMs)) return true; // can't compare → keep
    return noteMs >= sinceMs;
  });
}
