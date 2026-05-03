import gradient from 'gradient-string';

/**
 * Phase-shifted shimmer gradients for the chat status line.
 *
 * The visual goal is OpenCode's CSS gradient sweep, ported to the
 * terminal: a gold "peak" rides across a violet baseline, returning
 * frame after frame. Each phase is a fully-built gradient function
 * keyed on the hot path so `gradients[frame % count](text)` stays
 * O(string length).
 *
 * Construction:
 *   - Linear color stops: violet at 0, gold peak centered at `phase`,
 *     violet at 1. The peak has a small plateau (`PEAK_HALF_WIDTH`) so
 *     short verbs still see the full violet→gold→violet transition.
 *   - When the peak is near 0 or 1, we clamp stops to [0, 1] and let
 *     the gradient wrap visually as the phase advances. The result is a
 *     smooth horizontal sweep without a hard reset.
 *
 * Caller contract:
 *   - `count` is the phase resolution (24 by default = 2.4 s loop at
 *     100 ms tick). Higher counts = smoother sweep but more memory.
 *   - The returned array is frozen. Indexing with `frame % count` is
 *     safe.
 *   - Each function returns ANSI-coded text. Callers should fall back
 *     to plain text on `NO_COLOR` / non-truecolor terminals; this
 *     module does NOT detect color support — rendering fallback is the
 *     consumer's responsibility.
 */

export interface ShimmerPaletteInput {
  readonly violet: string;
  readonly gold: string;
  readonly count?: number;
}

export type ShimmerGradientFn = (text: string) => string;

const DEFAULT_COUNT = 24;
const PEAK_HALF_WIDTH = 0.18;
/**
 * Stop sample density for the toroidal shimmer reconstruction. 12
 * samples spaced at 1/12 give a smooth interpolated peak ≈ ±0.18 wide
 * without visible faceting — gradient-string interpolates between
 * adjacent stops, so the peak's leading/trailing edges read as a
 * continuous violet→gold→violet ramp.
 */
const SAMPLE_COUNT = 12;

export function buildShimmerGradients(input: ShimmerPaletteInput): readonly ShimmerGradientFn[] {
  const count = input.count ?? DEFAULT_COUNT;
  if (!Number.isInteger(count) || count < 2) {
    throw new RangeError(`shimmer count must be an integer >= 2, got ${count}`);
  }
  const violetRgb = parseHex(input.violet);
  const goldRgb = parseHex(input.gold);

  const fns: ShimmerGradientFn[] = [];
  for (let i = 0; i < count; i += 1) {
    const phase = i / count;
    const stops = buildStops(violetRgb, goldRgb, phase);
    const g = gradient(stops);
    fns.push((text: string) => g(text));
  }
  return Object.freeze(fns);
}

interface Stop {
  readonly color: string;
  readonly pos: number;
}

interface RGB {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Audit 3B.3 M2: previous `buildStops` clamped peak stops to [0, 1] and
 * so produced a discontinuous loop — the gold "blob" snapped from the
 * right edge to the left edge between frame 23 and frame 0, visible as
 * a ~100 ms jolt every 2.4 s loop.
 *
 * Fix: sample a fixed grid of stop positions and color each by the
 * toroidal distance from `phase`. The "torus" makes the peak continuous
 * at the seam — when `phase` is near 1, samples near 0 are also colored
 * gold (and vice versa), so the blob smoothly straddles the boundary.
 */
function buildStops(violet: RGB, gold: RGB, phase: number): Stop[] {
  const stops: Stop[] = [];
  for (let i = 0; i <= SAMPLE_COUNT; i += 1) {
    const x = i / SAMPLE_COUNT;
    const linear = Math.abs(x - phase);
    const dist = Math.min(linear, 1 - linear);
    const t = Math.min(1, dist / PEAK_HALF_WIDTH);
    stops.push({ color: blendHex(gold, violet, t), pos: x });
  }
  return stops;
}

function parseHex(hex: string): RGB {
  // Accept `#RRGGBB`. tinycolor2 (transitive via gradient-string)
  // tolerates more, but our consumer (theme tokens) always emits 6-char
  // hex. Defensive: throw on shorter input rather than silently render
  // black.
  const stripped = hex.startsWith('#') ? hex.slice(1) : hex;
  if (stripped.length !== 6) {
    throw new RangeError(`shimmer color must be #RRGGBB, got ${hex}`);
  }
  return {
    r: parseInt(stripped.slice(0, 2), 16),
    g: parseInt(stripped.slice(2, 4), 16),
    b: parseInt(stripped.slice(4, 6), 16),
  };
}

function blendHex(a: RGB, b: RGB, t: number): string {
  const clamp = Math.max(0, Math.min(1, t));
  const r = Math.round(a.r + (b.r - a.r) * clamp);
  const g = Math.round(a.g + (b.g - a.g) * clamp);
  const bl = Math.round(a.b + (b.b - a.b) * clamp);
  return `#${toHex(r)}${toHex(g)}${toHex(bl)}`;
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, '0');
}
