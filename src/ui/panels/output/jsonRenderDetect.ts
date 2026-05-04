/**
 * Phase 3D.2 — fence detector for ` ```json-render ` blocks.
 *
 * Splits an `assistant_text` event's body into a sequence of segments:
 * either plain text, or a parsed/invalid spec block. The detector is a
 * pure synchronous function — no state, no React, no Ink. Render-time
 * use only (called from `EventRow.tsx case 'assistant_text'`).
 *
 * Pattern mirrors `src/workers/completion-report.ts:3` — same CRLF-aware
 * regex shape — but operates in document order (NOT last-to-first):
 * we want every block, not "first valid wins."
 *
 * Boundary handling per PLAN.md §3D.2: leading/trailing-only-whitespace
 * text segments are dropped (the fence's own newlines should not
 * cascade into double-spacing in the rendered output).
 *
 * Stream-parser invariant relied on: each `assistant_text` event carries
 * one full Anthropic API text block (`src/workers/stream-parser.ts:140-148`),
 * NOT a chunk delta. So "fence split across two events" is not a
 * concern under the current parser. If that invariant ever changes,
 * this detector degrades gracefully — partial fences (no closing
 * delimiter) match nothing and render as plain text.
 */

const FENCE_RE = /```json-render\s*\r?\n([\s\S]*?)\r?\n```/g;

export type TextSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'spec'; readonly spec: unknown; readonly raw: string }
  | { readonly kind: 'invalid'; readonly reason: string; readonly raw: string };

export interface DetectResult {
  readonly segments: readonly TextSegment[];
}

/**
 * Scan `text` for ` ```json-render ` fences and return a flat list of
 * typed segments in document order. Plain text between fences becomes
 * `{kind:'text'}`; valid JSON inside a fence becomes `{kind:'spec'}`;
 * malformed JSON inside a fence becomes `{kind:'invalid'}`.
 *
 * Whitespace-only text segments are filtered out (a fence delimiter
 * always follows a newline, and we don't want that newline to render
 * as a blank line above the spec).
 */
export function detectJsonRenderBlocks(text: string): DetectResult {
  const matches = [...text.matchAll(FENCE_RE)];
  if (matches.length === 0) {
    return { segments: [{ kind: 'text', value: text }] };
  }

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    const matchStart = match.index;
    if (matchStart === undefined) continue;
    const matchEnd = matchStart + match[0].length;

    // Plain text between previous match end and this fence start.
    if (matchStart > cursor) {
      const between = text.slice(cursor, matchStart);
      if (!isWhitespaceOnly(between)) {
        segments.push({ kind: 'text', value: between });
      }
    }

    const raw = match[1] ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      segments.push({ kind: 'spec', spec: parsed, raw });
    } catch (err) {
      const reason =
        err instanceof Error ? err.message : String(err);
      segments.push({ kind: 'invalid', reason, raw });
    }

    cursor = matchEnd;
  }

  // Trailing text after the last fence.
  if (cursor < text.length) {
    const trailing = text.slice(cursor);
    if (!isWhitespaceOnly(trailing)) {
      segments.push({ kind: 'text', value: trailing });
    }
  }

  return { segments };
}

function isWhitespaceOnly(s: string): boolean {
  return s.length === 0 || /^\s+$/.test(s);
}
