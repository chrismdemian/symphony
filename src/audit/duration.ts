/**
 * Phase 3R — Duration parser for `/log --last 1h` filter syntax.
 *
 * Accepts compound durations: `1h`, `30m`, `2h30m`, `7d`, `2w`, `45s`.
 * Whitespace within the input is ignored. Negative numbers reject.
 * Fractional values reject (no `1.5h`). Empty / zero / NaN reject.
 *
 * Returns the duration in milliseconds, or `null` if the input is
 * malformed.
 *
 * Use the multiplier table — adding `'mo'` or `'y'` is a single map
 * entry and a regex update (extending the unit alternation).
 */

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

const SEGMENT_RE = /^(\d+)(s|m|h|d|w)$/;

export function parseDuration(input: string): number | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Split on the boundary BETWEEN unit and the next digit: `2h30m` → ['2h','30m'].
  // Insertion of a space at every unit→digit junction makes split clean.
  const segments = trimmed.replace(/([smhdw])(\d)/gi, '$1 $2').split(/\s+/);

  let total = 0;
  for (const seg of segments) {
    if (seg.length === 0) continue;
    const m = SEGMENT_RE.exec(seg.toLowerCase());
    if (m === null) return null;
    const n = Number.parseInt(m[1] ?? '', 10);
    if (!Number.isFinite(n) || n < 0) return null;
    const unit = m[2];
    if (unit === undefined) return null;
    const mult = UNIT_MS[unit];
    if (mult === undefined) return null;
    total += n * mult;
  }
  if (total <= 0) return null;
  return total;
}

/**
 * Compute the ISO timestamp `durationMs` ago from `nowEpochMs`.
 * Returns `null` if the duration is invalid.
 */
export function sinceTimestamp(
  duration: string,
  nowEpochMs: number = Date.now(),
): string | null {
  const ms = parseDuration(duration);
  if (ms === null) return null;
  return new Date(nowEpochMs - ms).toISOString();
}
