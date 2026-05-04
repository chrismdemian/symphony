/**
 * Phase 3F.4 — diff colorizer for the output panel.
 *
 * Workers emit ` ```diff ` blocks; each line is prefix-colored. Pure
 * synchronous function, no per-line allocations beyond the line array
 * itself. Convention is the universal git/unified-diff color scheme:
 *
 *   `+` lines  → diffAdd (green)
 *   `-` lines  → diffRemove (red)
 *   `@@`       → diffHunk (cyan)
 *   default    → outputText
 *   `\ No newline at end of file` → muted gray (metadata)
 *
 * Returns one DiffLine per source line, in document order.
 */

export type DiffLineKind = 'add' | 'remove' | 'hunk' | 'meta' | 'context';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
}

export function colorizeDiff(source: string): readonly DiffLine[] {
  const lines = source.split('\n');
  return lines.map((line) => {
    if (line.startsWith('+++') || line.startsWith('---')) {
      // File-header lines (`+++ b/foo` / `--- a/foo`) — meta.
      return { kind: 'meta', text: line };
    }
    if (line.startsWith('@@')) {
      return { kind: 'hunk', text: line };
    }
    if (line.startsWith('\\')) {
      // `\ No newline at end of file` — meta annotation.
      return { kind: 'meta', text: line };
    }
    // Phase 3F.4 audit M2: tighten add/remove to "char + (space|content)"
    // shapes — a heading like `-- Notes:` or `++ Heading` inside a diff
    // fence used to misclassify as remove/add. Also catch the bare
    // single-char `+` / `-` (an empty add/remove line) and the standard
    // unified-diff prefix where the second char is a space.
    if (line === '+' || line.startsWith('+ ') || /^\+[^+]/.test(line)) {
      return { kind: 'add', text: line };
    }
    if (line === '-' || line.startsWith('- ') || /^-[^-]/.test(line)) {
      return { kind: 'remove', text: line };
    }
    return { kind: 'context', text: line };
  });
}
