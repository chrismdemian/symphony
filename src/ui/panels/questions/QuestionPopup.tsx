import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useAnimation } from 'ink';
import type { ProjectSnapshot } from '../../../projects/types.js';
import type { QuestionSnapshot } from '../../../state/question-registry.js';
import { useTheme } from '../../theme/context.js';
import { useFocus } from '../../focus/focus.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import { useAnswerQuestion } from '../../data/useAnswerQuestion.js';
import type { TuiRpc } from '../../runtime/rpc.js';
import { InputBar } from '../chat/InputBar.js';
import { UrgencyBadge } from './UrgencyBadge.js';
import { QuestionMeta } from './QuestionMeta.js';
import { QueueIndex } from './QueueIndex.js';

/**
 * Phase 3E question popup.
 *
 * Mounted by `<Layout>` when `focus.state` has a popup with key
 * `'question'` on top. Renders the oldest unanswered blocking question
 * (or oldest unanswered if none blocking), a multi-line answer
 * `<InputBar/>`, and a footer hint.
 *
 * Keybinds (popup scope `'question'`):
 *   - Esc            → close popup (focus.popPopup)
 *   - Tab            → next queued question
 *   - Shift+Tab      → prev queued question
 *
 * `Enter` is owned by `<InputBar/>` itself — pressing Enter inside the
 * input submits the buffered text via `props.onAnswer(id, text)`. Ctrl+J
 * inserts a newline (universal); Shift+Enter inserts a newline on
 * kitty-keyboard terminals (3B.3).
 *
 * The InputBar's `isActive` is gated on `focus.currentScope === 'question'`
 * so the chat panel's InputBar — whose `isActive` was tightened to use
 * `currentScope` in this same phase — does NOT compete for keystrokes.
 *
 * If the popup opens with zero queued questions (a stale `Ctrl+Q` press
 * after the queue drained), the popup auto-pops on mount.
 */

const SCOPE = 'question';

export interface QuestionPopupProps {
  readonly rpc: TuiRpc;
  readonly questions: readonly QuestionSnapshot[];
  readonly projects: readonly ProjectSnapshot[];
  /** Test seam — defaults to Date.now. Used by `formatRuntime`. */
  readonly now?: () => number;
}

export function QuestionPopup({
  rpc,
  questions,
  projects,
  now,
}: QuestionPopupProps): React.JSX.Element | null {
  const theme = useTheme();
  const focus = useFocus();
  const isFocused = focus.currentScope === SCOPE;
  const answer = useAnswerQuestion(rpc);
  const [activeIndex, setActiveIndex] = useState(0);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  // Lock the queue identity when the popup opens so insertions don't
  // shift the active index out from under the user mid-answer.
  // `useState(initializer)` runs the initializer once at mount and
  // pins the result for the component's lifetime — re-mount on next
  // popup open re-locks against the current queue.
  const [lockedIds] = useState<readonly string[]>(() => questions.map((q) => q.id));

  // Auto-clear confirmation after 1.2s.
  useEffect(() => {
    if (confirmation === null) return;
    const handle = setTimeout(() => setConfirmation(null), 1200);
    return () => clearTimeout(handle);
  }, [confirmation]);

  // Phase 3E audit M2: optimistic dismissal — once `submit` succeeds,
  // exclude the answered id from `visible` immediately so the popup
  // advances to the next question without waiting for the next 1 s
  // poll. Without this, the user could re-submit the same question
  // and trip `AlreadyAnsweredError` server-side.
  const [optimisticallyDismissed, setOptimisticallyDismissed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const visible = useMemo(() => {
    const lockedSet = new Set(lockedIds);
    const ordered: QuestionSnapshot[] = [];
    for (const id of lockedIds) {
      if (optimisticallyDismissed.has(id)) continue;
      const found = questions.find((q) => q.id === id);
      if (found !== undefined) ordered.push(found);
    }
    for (const q of questions) {
      if (!lockedSet.has(q.id) && !optimisticallyDismissed.has(q.id)) ordered.push(q);
    }
    return ordered;
  }, [lockedIds, questions, optimisticallyDismissed]);

  // Auto-pop when the popup opens with an empty queue, or all queued
  // questions have been answered out from under us. Depend on the
  // stable `popPopup` callback identity (FocusProvider memoizes it
  // with empty deps), NOT the whole `focus` controller — its identity
  // flips on every focus state change, which would re-fire this
  // effect every Tab press.
  const focusPopPopup = focus.popPopup;
  useEffect(() => {
    if (visible.length === 0) {
      focusPopPopup();
    }
  }, [visible.length, focusPopPopup]);

  // Clamp the active index when items disappear.
  useEffect(() => {
    if (visible.length === 0) return;
    if (activeIndex >= visible.length) setActiveIndex(visible.length - 1);
  }, [activeIndex, visible.length]);

  const onSubmit = useCallback(
    (text: string): void => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      const current = visible[activeIndex];
      if (current === undefined) return;
      const id = current.id;
      void answer.submit(id, trimmed).then((result) => {
        if (result.ok) {
          setConfirmation(`✓ answered ${id}`);
          // Audit M2: optimistically dismiss the answered id so the
          // popup advances NOW (don't wait 1 s for the next poll).
          // Clamp activeIndex so we land on the next-still-visible row.
          setOptimisticallyDismissed((prev) => {
            const next = new Set(prev);
            next.add(id);
            return next;
          });
          setActiveIndex((idx) => Math.max(0, Math.min(idx, visible.length - 2)));
        } else {
          // Audit m3: clear stale "answered" toast so the user doesn't
          // see two contradictory rows side-by-side after a retry that
          // hits AlreadyAnsweredError within the 1.2s confirmation
          // window.
          setConfirmation(null);
        }
      });
    },
    [answer, activeIndex, visible],
  );

  const cycle = useCallback(
    (delta: 1 | -1): void => {
      if (visible.length <= 1) return;
      setActiveIndex(
        (idx) => (idx + delta + visible.length) % visible.length,
      );
    },
    [visible.length],
  );

  // Audit m7: depend on stable identities (`focus.popPopup` is
  // `useCallback`'d once in FocusProvider with empty deps), not the
  // whole `focus` object — the controller's identity flips on every
  // state change, which would re-register the popup-scope keybinds
  // every Tab press.
  const popPopup = focus.popPopup;
  const popupCommands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'question.dismiss',
        title: 'dismiss',
        key: { kind: 'escape' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => popPopup(),
      },
      {
        id: 'question.next',
        title: 'next',
        key: { kind: 'tab' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => cycle(1),
      },
      {
        id: 'question.prev',
        title: 'prev',
        key: { kind: 'tab', shift: true },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => cycle(-1),
      },
    ],
    [popPopup, cycle],
  );

  useRegisterCommands(popupCommands, isFocused);

  // 1Hz tick so the QuestionMeta "asked X ago" label refreshes while the
  // popup stays open.
  const { frame: secondsTick } = useAnimation({ interval: 1000 });
  const nowMs = useMemo(() => {
    void secondsTick;
    return (now ?? Date.now)();
  }, [secondsTick, now]);

  const current = visible[activeIndex];
  if (current === undefined) {
    // Render a minimal frame while the auto-pop effect runs. Returning
    // `null` would cause the parent layout to render nothing, which can
    // briefly drop the popup border between renders.
    return (
      <Box
        flexDirection="column"
        flexGrow={1}
        borderStyle="round"
        borderColor={theme['accent']}
        paddingX={1}
      >
        <Text color={theme['textMuted']}>(no questions queued)</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor={theme['accent']}
      paddingX={1}
    >
      <Box flexDirection="row" marginBottom={0}>
        <Text color={theme['accent']} bold>
          Question
        </Text>
        <Text color={theme['textMuted']}> · {current.id}</Text>
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <UrgencyBadge urgency={current.urgency} />
        <Text> </Text>
        <QuestionMeta
          {...(current.projectId !== undefined ? { projectId: current.projectId } : {})}
          {...(current.workerId !== undefined ? { workerId: current.workerId } : {})}
          askedAt={current.askedAt}
          nowMs={nowMs}
          projects={projects}
        />
      </Box>
      <Box marginTop={1}>
        <Text color={theme['text']}>{current.question}</Text>
      </Box>
      {current.context !== undefined ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme['textMuted']}>Context:</Text>
          <Text color={theme['textMuted']}>  {current.context}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme['textMuted']}>Your answer:</Text>
        <InputBar onSubmit={onSubmit} isActive={isFocused} placeholder="Type your answer…" />
      </Box>
      {answer.state.kind === 'submitting' ? (
        <Text color={theme['textMuted']}>Submitting…</Text>
      ) : null}
      {/* Audit m2: only render the submit error when it pertains to the
          CURRENT question. A stale error from Q-1 must not stick to Q-2
          after the user Tabs forward. */}
      {answer.state.kind === 'error' && answer.state.questionId === current.id ? (
        <Text color={theme['error']}>Submit failed: {answer.state.message}</Text>
      ) : null}
      {confirmation !== null ? (
        <Text color={theme['success']}>{confirmation}</Text>
      ) : null}
      <Box marginTop={1}>
        <QueueIndex index={activeIndex} total={visible.length} />
      </Box>
    </Box>
  );
}
