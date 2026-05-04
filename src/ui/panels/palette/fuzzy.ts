import fuzzysort from 'fuzzysort';
import type { Command } from '../../keybinds/registry.js';

/**
 * Fuzzy match wrapper for the command palette.
 *
 * fuzzysort 3.x scoring: 1 = perfect, 0.5 = good, 0 = no match.
 * `indexes` contains the matched character positions in the title
 * (UTF-16 code-unit offsets), used for char-level highlight rendering.
 *
 * Empty query returns ALL commands in registry order (no scoring) so
 * the palette renders the full list on initial open.
 */
export interface PaletteMatch {
  readonly cmd: Command;
  readonly indexes: readonly number[];
  readonly score: number;
}

const DEFAULT_LIMIT = 50;
const NO_MATCH_THRESHOLD = 0.0;

export function fuzzyFilter(
  commands: readonly Command[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): readonly PaletteMatch[] {
  const trimmed = query.trim();
  if (trimmed === '') {
    return commands.slice(0, limit).map((cmd) => ({ cmd, indexes: [], score: 1 }));
  }
  const results = fuzzysort.go(trimmed, commands as Command[], {
    key: 'title',
    limit,
    threshold: NO_MATCH_THRESHOLD,
  });
  return results.map((r) => ({
    cmd: r.obj,
    indexes: Array.from(r.indexes),
    score: r.score,
  }));
}
