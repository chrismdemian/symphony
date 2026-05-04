import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../../theme/context.js';
import { useFocus } from '../../focus/focus.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import { useAnsweredQuestions } from '../../data/useAnsweredQuestions.js';
import type { TuiRpc } from '../../runtime/rpc.js';
import type { ProjectSnapshot } from '../../../projects/types.js';
import { UrgencyBadge } from './UrgencyBadge.js';

/**
 * Phase 3F.3 — read-only history of answered questions.
 *
 * Mounted by `<Layout>` when the focus stack has a popup with key
 * `'question-history'` on top. Polls `rpc.call.questions.list({
 * answered: true })` every 2s while open, sorts newest-first, and
 * renders a scrollable list. Esc closes.
 *
 * Distinct from QuestionPopup — this never accepts input or fires
 * answers; the action history is informational only.
 */

const SCOPE = 'question-history';
const VISIBLE_ROWS = 12;

export interface QuestionHistoryProps {
  readonly rpc: TuiRpc;
  readonly projects: readonly ProjectSnapshot[];
}

export function QuestionHistory({
  rpc,
  projects,
}: QuestionHistoryProps): React.JSX.Element {
  const theme = useTheme();
  const focus = useFocus();
  const isFocused = focus.currentScope === SCOPE;
  const { questions, count, loading, error } = useAnsweredQuestions(rpc, {
    enabled: isFocused,
  });
  const [selectedIdx, setSelectedIdx] = useState(0);

  const clampedIdx = count === 0 ? 0 : Math.min(selectedIdx, count - 1);

  const popPopup = focus.popPopup;

  // Mirror count via ref so move() can clamp to upper bound without
  // pulling `count` into useCallback deps (which would defeat the
  // identity-stability pattern shared with Palette/WorkerSelector).
  // Phase 3F.3 audit M1: without clamp, holding ↓ grew selectedIdx
  // unboundedly; render-time `clampedIdx` masked the bug visually
  // but state leaked.
  const countRef = useRef(count);
  useEffect(() => {
    countRef.current = count;
  }, [count]);

  const move = useCallback((delta: 1 | -1): void => {
    const total = countRef.current;
    if (total === 0) return;
    setSelectedIdx((idx) => {
      const next = idx + delta;
      if (next < 0) return 0;
      if (next >= total) return total - 1;
      return next;
    });
  }, []);

  const popupCommands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'question-history.dismiss',
        title: 'close',
        key: { kind: 'escape' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => popPopup(),
      },
      {
        id: 'question-history.next',
        title: 'next',
        key: { kind: 'downArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => move(1),
      },
      {
        id: 'question-history.prev',
        title: 'prev',
        key: { kind: 'upArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => move(-1),
      },
    ],
    [popPopup, move],
  );

  useRegisterCommands(popupCommands, isFocused);

  const projectsById = useMemo(() => {
    const map = new Map<string, ProjectSnapshot>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const window = useMemo(() => {
    const total = count;
    if (total <= VISIBLE_ROWS) return { start: 0, end: total };
    let start = Math.max(0, clampedIdx - Math.floor(VISIBLE_ROWS / 2));
    const end = Math.min(total, start + VISIBLE_ROWS);
    start = Math.max(0, end - VISIBLE_ROWS);
    return { start, end };
  }, [count, clampedIdx]);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor={theme['accent']}
      paddingX={1}
    >
      <Box flexDirection="row" marginBottom={1}>
        <Text color={theme['accent']} bold>
          Answered questions
        </Text>
        <Text color={theme['textMuted']}>
          {' '}
          · {count}
          {loading ? ' (loading)' : ''}
        </Text>
      </Box>
      {error !== null ? (
        <Text color={theme['error']}>Failed to load history: {error.message}</Text>
      ) : count === 0 ? (
        <Text color={theme['textMuted']}>(no answered questions yet)</Text>
      ) : (
        <Box flexDirection="column">
          {questions.slice(window.start, window.end).map((q, i) => {
            const absIdx = window.start + i;
            const project =
              q.projectId !== undefined ? projectsById.get(q.projectId) : undefined;
            const selected = absIdx === clampedIdx;
            return (
              <Box key={q.id} flexDirection="column" marginBottom={1}>
                <Box flexDirection="row">
                  <Text color={selected ? theme['accent'] : theme['textMuted']}>
                    {selected ? '▸ ' : '  '}
                  </Text>
                  <UrgencyBadge urgency={q.urgency} />
                  <Text color={theme['textMuted']}> · {q.id}</Text>
                  {project !== undefined ? (
                    <Text color={theme['textMuted']}> · {project.name}</Text>
                  ) : null}
                </Box>
                <Box flexDirection="column" marginLeft={2}>
                  <Text color={theme['text']}>Q: {q.question}</Text>
                  {q.answer !== undefined ? (
                    <Text color={theme['textMuted']}>A: {q.answer}</Text>
                  ) : null}
                </Box>
              </Box>
            );
          })}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme['textMuted']}>↑↓ to scroll · Esc to close</Text>
      </Box>
    </Box>
  );
}
