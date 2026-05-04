/**
 * Phase 3F.4 — fence detector for generic markdown code/diff blocks.
 *
 * Mirrors the architectural pattern of `jsonRenderDetect.ts` (3D.2):
 * pure synchronous function, document-order walk, CRLF-aware regex,
 * graceful unclosed-fence fallback. Distinct because:
 *
 *   - Matches ANY language tag: ` ```ts `, ` ```py `, ` ```diff `, etc.
 *     The `'json-render'` tag is RESERVED and explicitly excluded — that
 *     is `jsonRenderDetect.ts`'s job and runs FIRST in `EventRow.tsx`.
 *   - Returns `code` / `diff` discriminants on the segment union; no
 *     parse step (the highlighter / diff colorizer downstream handles
 *     tokenization).
 *
 * Stream-parser invariant relied on (same as jsonRenderDetect): each
 * `assistant_text` event carries one full Anthropic API text block. A
 * fence split across two events would land in two events as plain
 * text (no closing delimiter → no match).
 */

const FENCE_RE = /```(\w+)?\s*\r?\n([\s\S]*?)\r?\n```/g;

export type CodeSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'code'; readonly lang: string; readonly source: string }
  | { readonly kind: 'diff'; readonly source: string };

export interface DetectResult {
  readonly segments: readonly CodeSegment[];
}

/** The reserved language tag is owned by `jsonRenderDetect.ts`. */
const RESERVED_TAGS: ReadonlySet<string> = new Set(['json-render']);

/**
 * Scan `text` for markdown fence blocks and return a flat list of
 * typed segments in document order. Fences with the reserved
 * `json-render` tag are passed through as plain text (so the
 * upstream `detectJsonRenderBlocks` pass handles them).
 *
 * Whitespace-only text segments between fences are dropped (the
 * fence's surrounding newlines should not render as a blank line
 * above the code block).
 */
export function detectMarkdownFences(text: string): DetectResult {
  const matches = [...text.matchAll(FENCE_RE)];
  // Filter out reserved-tag matches — they fall through as text.
  const eligible = matches.filter((m) => {
    const tag = (m[1] ?? '').trim().toLowerCase();
    return !RESERVED_TAGS.has(tag);
  });
  if (eligible.length === 0) {
    return { segments: [{ kind: 'text', value: text }] };
  }

  const segments: CodeSegment[] = [];
  let cursor = 0;
  for (const match of eligible) {
    const matchStart = match.index;
    if (matchStart === undefined) continue;
    const matchEnd = matchStart + match[0].length;

    if (matchStart > cursor) {
      const between = text.slice(cursor, matchStart);
      if (!isWhitespaceOnly(between)) {
        segments.push({ kind: 'text', value: between });
      }
    }

    const tag = (match[1] ?? '').trim().toLowerCase();
    const source = match[2] ?? '';
    if (tag === 'diff' || tag === 'patch') {
      segments.push({ kind: 'diff', source });
    } else {
      segments.push({ kind: 'code', lang: tag, source });
    }

    cursor = matchEnd;
  }

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
