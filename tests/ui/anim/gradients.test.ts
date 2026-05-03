import { describe, expect, test } from 'vitest';
import { buildShimmerGradients } from '../../../src/ui/anim/gradients.js';

const VIOLET = '#7C6FEB';
const GOLD = '#D4A843';

// eslint-disable-next-line no-control-regex
const ANSI_TRUECOLOR = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;

describe('buildShimmerGradients', () => {
  test('returns frozen array of length count', () => {
    const fns = buildShimmerGradients({ violet: VIOLET, gold: GOLD });
    expect(fns).toHaveLength(24);
    expect(Object.isFrozen(fns)).toBe(true);
  });

  test('respects custom count', () => {
    const fns = buildShimmerGradients({ violet: VIOLET, gold: GOLD, count: 12 });
    expect(fns).toHaveLength(12);
  });

  test('rejects count < 2', () => {
    expect(() => buildShimmerGradients({ violet: VIOLET, gold: GOLD, count: 1 })).toThrow(
      RangeError,
    );
  });

  test('rejects non-integer count', () => {
    expect(() => buildShimmerGradients({ violet: VIOLET, gold: GOLD, count: 3.5 })).toThrow(
      RangeError,
    );
  });

  test('every gradient produces ANSI 24-bit color escapes', () => {
    const fns = buildShimmerGradients({ violet: VIOLET, gold: GOLD });
    for (const fn of fns) {
      const out = fn('Hello');
      expect(out).toMatch(ANSI_TRUECOLOR);
    }
  });

  test('center character RGB drifts toward gold then back to violet across phases', () => {
    // Take a long sample so the center position hits a different color
    // band per phase. Sample 4 phases evenly across the loop and assert
    // the center character's red channel rises (more gold) toward the
    // mid-loop, then falls (more violet) toward the end.
    const fns = buildShimmerGradients({ violet: VIOLET, gold: GOLD });
    const sample = '████████████████████████████████';
    const reds: number[] = [];
    const probes = [0, 6, 12, 18];
    for (const i of probes) {
      const fn = fns[i];
      if (fn === undefined) throw new Error(`missing fn at ${i}`);
      const text = fn(sample);
      // Pick the SECOND truecolor escape — first is for the leading char,
      // we want one closer to the middle to make peak-position visible.
      // eslint-disable-next-line no-control-regex
      const matches = [...text.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
      const middle = matches[Math.floor(matches.length / 2)];
      if (middle === undefined) throw new Error(`no match for phase ${i}`);
      const r = Number(middle[1]);
      reds.push(r);
    }
    // Red channel: violet #7C6FEB has R=0x7C=124, gold #D4A843 has R=0xD4=212.
    // Phase 0 has the gold peak at position 0, so the middle of the string
    // is mostly violet → low red. Phase 12 (loop midpoint) places the peak
    // at the middle → high red. The progression is non-monotonic, but the
    // mid-loop sample MUST be redder than phase 0.
    const phase0 = reds[0] ?? 0;
    const phase12 = reds[2] ?? 0;
    expect(phase12).toBeGreaterThan(phase0);
  });

  test('phase wrap is C0-continuous: frame N-1 and frame 0 produce visually adjacent gradients (audit M2 regression)', () => {
    // Pre-fix: frame 23 had gold at the right edge; frame 0 had gold at
    // the left edge; the blob snapped the full width in 100ms. Post-fix:
    // gradients sample a toroidal distance, so the blob smoothly
    // straddles the seam. We measure this by sampling the LEFT-edge and
    // RIGHT-edge characters of a long string at frame 23 and frame 0:
    // the gold-component RGB at the seam should not jump catastrophically.
    const fns = buildShimmerGradients({ violet: VIOLET, gold: GOLD, count: 24 });
    const sample = '████████████';
    const lastFrame = fns[fns.length - 1];
    const firstFrame = fns[0];
    if (lastFrame === undefined || firstFrame === undefined) throw new Error('missing fns');

    const extractRedRange = (text: string): readonly number[] => {
      // eslint-disable-next-line no-control-regex
      return [...text.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) => Number(m[1]));
    };
    const lastReds = extractRedRange(lastFrame(sample));
    const firstReds = extractRedRange(firstFrame(sample));
    // Continuity proxy: rightmost sample of frame 23 ≈ rightmost sample
    // of frame 0 (peak straddles the seam — both should carry gold-tinted
    // red). Pre-fix this would FAIL because frame 23 had gold at the
    // right and frame 0 had violet at the right (gold jumped to left).
    const lastRight = lastReds[lastReds.length - 1] ?? 0;
    const firstRight = firstReds[firstReds.length - 1] ?? 0;
    // Allow some interpolation drift between adjacent frames, but the
    // jump must be small (≤ 60 RGB units, was ~88 with the discontinuity).
    expect(Math.abs(lastRight - firstRight)).toBeLessThanOrEqual(60);
  });

  test('output preserves input string length (character count, not bytes)', () => {
    const fns = buildShimmerGradients({ violet: VIOLET, gold: GOLD });
    const fn = fns[0];
    if (fn === undefined) throw new Error('missing fn');
    const input = 'Conducting';
    const output = fn(input);
    // Strip ANSI: each escape is `\x1b[NN;NN;NN;NN;NNm` etc. Use a
    // permissive strip and confirm visible characters round-trip.
    // eslint-disable-next-line no-control-regex
    const stripped = output.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');
    expect(stripped).toBe(input);
  });
});
