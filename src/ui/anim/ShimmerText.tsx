import React, { useMemo } from 'react';
import { Text, useAnimation } from 'ink';
import { useTheme } from '../theme/context.js';
import { buildShimmerGradients, type ShimmerGradientFn } from './gradients.js';

/**
 * ShimmerText — animated violet→gold→violet sweep over short labels.
 *
 * Replicates OpenCode's CSS gradient-sweep aesthetic in the terminal:
 * a moving gold "peak" rides across a violet baseline, looping every
 * `count * interval` ms. Used for the chat status-line verb during
 * in-flight turns.
 *
 * Implementation:
 *   - Pre-builds a frozen array of `count` gradient functions at mount
 *     time (via `useMemo`), then indexes by `frame % count` from
 *     `useAnimation({interval: 100})`.
 *   - When `process.env.NO_COLOR` is set OR chalk's color level is
 *     below truecolor, falls back to a plain accent-colored `<Text>`.
 *     gradient-string emits raw `\x1b[38;2;...m` regardless of chalk's
 *     level, but the visual quality on 16-color terminals is poor —
 *     better to render flat than to look broken.
 *
 * `React.memo`'d on `text` identity. Only `useAnimation` re-renders
 * the leaf each tick.
 */

export interface ShimmerTextProps {
  /** Label to render. Empty string → plain placeholder. */
  readonly text: string;
  /** Gates the animation — false → flat accent text, no timer. */
  readonly isActive?: boolean;
  /** Phase resolution. Default 24. */
  readonly count?: number;
}

const TICK_MS = 100;

function ShimmerTextImpl({
  text,
  isActive = true,
  count = 24,
}: ShimmerTextProps): React.JSX.Element {
  const theme = useTheme();
  const violet = theme['accent'] ?? '#7C6FEB';
  const gold = theme['primary'] ?? '#D4A843';

  const gradients = useMemo<readonly ShimmerGradientFn[]>(
    () => buildShimmerGradients({ violet, gold, count }),
    [violet, gold, count],
  );

  // Audit 3B.3 m3: skip the animation subscription when there's nothing
  // to render. `useAnimation`'s timer subscription is global (Ink
  // consolidates), so a no-op subscriber is cheap, but stays cleanest
  // by gating `isActive` on `text.length > 0`.
  const { frame } = useAnimation({
    interval: TICK_MS,
    isActive: isActive && text.length > 0,
  });

  if (text.length === 0) {
    return <Text />;
  }

  if (!isActive || isPlainTextMode()) {
    return <Text color={theme['accent']}>{text}</Text>;
  }

  const fn = gradients[frame % gradients.length];
  if (fn === undefined) {
    return <Text color={theme['accent']}>{text}</Text>;
  }
  return <Text>{fn(text)}</Text>;
}

export const ShimmerText = React.memo(ShimmerTextImpl);

function isPlainTextMode(): boolean {
  // gradient-string emits ANSI through chalk, which honors NO_COLOR.
  // We mirror the check at the React boundary so the static fallback
  // path is taken even before gradient-string is consulted.
  return process.env['NO_COLOR'] !== undefined;
}
