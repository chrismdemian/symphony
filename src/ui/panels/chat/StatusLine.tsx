import React from 'react';
import { Box, Text } from 'ink';
import { Equalizer } from '../../anim/Equalizer.js';
import { ShimmerText } from '../../anim/ShimmerText.js';
import { pickVerb } from './verbMap.js';
import type { TurnState } from '../../data/turnStateReducer.js';
import type { Turn } from '../../data/chatHistoryReducer.js';

/**
 * Chat status line — Equalizer + shimmering verb.
 *
 * Visible only when Maestro is mid-turn. The visible content is:
 *
 *   ▆▂▇▄  Conducting
 *
 * where the EQ pulses violet and the verb sweeps violet→gold→violet.
 *
 * Mounting strategy: the parent (`ChatPanel`) mounts this UNCONDITIONALLY.
 * The component renders an empty `<Box height={1}/>` when idle so the
 * input bar doesn't shift up/down on every turn. Re-mounting on every
 * turn would reset `useAnimation`'s frame counter to 0 and cause a
 * visible "snap" stutter.
 *
 * `hasOpenTextBlock` heuristic for verb selection: derived from the last
 * block of the most recent assistant turn — `text` block at the tail
 * means the model is generating prose right now (Phrasing). Pure logic
 * exposed via `deriveHasOpenTextBlock()` for unit testing.
 */

export interface StatusLineProps {
  readonly turn: TurnState;
  readonly turns: readonly Turn[];
}

export function deriveHasOpenTextBlock(turns: readonly Turn[]): boolean {
  const last = turns[turns.length - 1];
  if (last === undefined || last.kind !== 'assistant') return false;
  if (last.complete) return false;
  const tail = last.blocks[last.blocks.length - 1];
  return tail !== undefined && tail.kind === 'text';
}

export function StatusLine({ turn, turns }: StatusLineProps): React.JSX.Element {
  if (!turn.inFlight) {
    // Reserve one row so the layout doesn't reflow when the line appears.
    return <Box height={1} />;
  }
  const verb = pickVerb({
    currentTool: turn.currentTool,
    hasOpenTextBlock: deriveHasOpenTextBlock(turns),
  });
  return (
    <Box height={1} flexDirection="row">
      <Equalizer isActive />
      <Text> </Text>
      <ShimmerText text={verb} isActive />
    </Box>
  );
}
