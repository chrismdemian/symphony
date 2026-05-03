import React from 'react';
import { Text, useAnimation } from 'ink';
import { useTheme } from '../theme/context.js';

/**
 * Symphony Spinner — 4-column phased multi-bar EQ.
 *
 * Visual: four vertical bars, each independently animated by a phase-
 * shifted sine wave. Bars rise and fall in `▁▂▃▄▅▆▇█` glyphs at a
 * 90 ms tick. The audio-meter aesthetic is intentional — Symphony is an
 * orchestrator; the EQ visually echoes the metaphor.
 *
 * Implementation:
 *   - Single `useAnimation({interval: 90})` subscription (Ink consolidates
 *     all animations into one timer, so cost is bounded).
 *   - `time` (ms) drives a continuous sine wave per column. Discrete
 *     `frame` is unused — the bar height is a pure function of elapsed
 *     time, which lets the animation interpolate smoothly even when
 *     Ink's render throttle coalesces ticks.
 *   - Each column gets a fixed phase offset so the bars don't move in
 *     lockstep. Column phases: 0, π/2, π, 3π/2 (quarter-period stagger).
 *   - Color: `theme['accent']` (violet by default). Pure-leaf component
 *     so the animation tick re-renders only this `<Text>`.
 *
 * Performance: `React.memo` on identity. The only prop is `isActive`,
 * which is referentially stable from the parent.
 */

const GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
const COLUMN_COUNT = 4;
const PHASE_STAGGER = (2 * Math.PI) / COLUMN_COUNT; // π/2
const SINE_PERIOD_MS = 720; // one full bar oscillation in ~0.72 s

export interface EqualizerProps {
  /** Gates the animation hook. When false, the component renders a flat
   * baseline (`▁▁▁▁`) without subscribing to the timer. */
  readonly isActive?: boolean;
}

function EqualizerImpl({ isActive = true }: EqualizerProps): React.JSX.Element {
  const theme = useTheme();
  const { time } = useAnimation({ interval: 90, isActive });

  if (!isActive) {
    return <Text color={theme['accent']}>{GLYPHS[0]?.repeat(COLUMN_COUNT) ?? ''}</Text>;
  }

  const bars = renderBars(time);
  return <Text color={theme['accent']}>{bars}</Text>;
}

export const Equalizer = React.memo(EqualizerImpl);

/**
 * Compute the 4-column glyph string at elapsed time `time` (ms). Pure;
 * exported for unit testing the height-mapping logic without rendering.
 */
export function renderBars(time: number): string {
  // Audit 3B.3 m2: defensive NaN/Infinity guard. Practically unreachable
  // (would require a 285M-year session) but keeps the height mapping
  // correct under degenerate `time` inputs (test fixtures, future
  // animation framework swaps).
  const safeTime = Number.isFinite(time) ? time : 0;
  let out = '';
  for (let col = 0; col < COLUMN_COUNT; col += 1) {
    const phase = col * PHASE_STAGGER;
    // sine: -1..1 → normalize to 0..1 → index into GLYPHS.
    const raw = Math.sin((2 * Math.PI * safeTime) / SINE_PERIOD_MS + phase);
    const normalized = (raw + 1) / 2; // 0..1
    const idx = Math.min(GLYPHS.length - 1, Math.floor(normalized * GLYPHS.length));
    out += GLYPHS[idx] ?? GLYPHS[0];
  }
  return out;
}

export const EQUALIZER_GLYPHS = GLYPHS;
