import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../theme/context.js';

/**
 * Phase 3S — Mission Control inline input.
 *
 * Single-line text input rendered at the bottom of `<WorkerOutputContainer>`
 * when the user presses `i` on a focused output panel. Esc cancels and
 * dismisses; Enter submits via `onSubmit` and clears.
 *
 * Key whitelist mirrors `InputBar` (the chat input) — ctrl/meta combos
 * fall through to the dispatcher (so Ctrl+Y still cycles autonomy mid-
 * type), arrows and tab are reserved for nav, and the row only accepts
 * printable input. Multi-char paste-style input is allowed.
 *
 * The component is "controlled" only insofar as `onSubmit` triggers an
 * RPC; while in-flight, the input is locked (no further keystrokes
 * accepted) and the cursor shows a different glyph. Pre-submit Esc is
 * accepted and unlocks the parent's view.
 *
 * Audit notes:
 *   - `useInput({ isActive: true })` — registered unconditionally when
 *     mounted. The parent only mounts this when `injectActive === true`,
 *     so input capture is scoped to the active-mode window. Mounting in
 *     a popup-on-top scenario is the parent's responsibility (3S only
 *     activates inject when output is focused).
 *   - Backspace handled explicitly (the key whitelist filter rejects it
 *     in the printable branch).
 *   - `submittedAt` ref-mirrors `submitting` for the async settle path
 *     so the post-`onSubmit` cleanup doesn't double-fire if React
 *     commits before the promise resolves.
 */

export interface OutputInlineInputProps {
  /** Worker name resolved by the parent (via InstrumentNameContext). */
  readonly workerName: string;
  /** Submit handler — receives the typed text. Caller wires to RPC. */
  readonly onSubmit: (text: string) => Promise<void> | void;
  /** Esc handler — parent flips inject mode off. */
  readonly onCancel: () => void;
}

export function OutputInlineInput({
  workerName,
  onSubmit,
  onCancel,
}: OutputInlineInputProps): React.JSX.Element {
  const theme = useTheme();
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const unmountedRef = useRef(false);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const submit = useCallback(async () => {
    if (submittingRef.current) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
    } finally {
      if (!unmountedRef.current) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }, [text, onSubmit]);

  useInput((input, key) => {
    // While the submit is in-flight, swallow input. Esc still works to
    // cancel — but only after the RPC settles (the parent owns dismissal
    // via onCancel; we route Esc through that even mid-flight so a
    // stuck server doesn't trap the user).
    if (submittingRef.current) {
      if (key.escape) onCancel();
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      void submit();
      return;
    }
    if (key.backspace || key.delete) {
      setText((t) => t.slice(0, -1));
      return;
    }
    // InputBar-style negative whitelist: reject control / navigation
    // keys so they fall through to the dispatcher. Ctrl+Y still cycles
    // tier, Ctrl+P still opens palette, Tab still cycles focus.
    if (
      key.ctrl ||
      key.meta ||
      key.tab ||
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow ||
      key.pageUp ||
      key.pageDown
    ) {
      return;
    }
    // Printable + paste. Ink's useInput delivers paste-style input as
    // a single multi-char `input` value.
    if (input.length >= 1) {
      setText((t) => t + input);
    }
  });

  return (
    <Box flexDirection="row" paddingX={1}>
      <Text color={theme['accent']} bold>
        {submitting ? '↻ ' : '↪ '}
      </Text>
      <Text color={theme['textMuted']}>{workerName} </Text>
      <Text color={theme['text']}>{text}</Text>
      {/* Inverse-block cursor mirrors InputBar's affordance. Always-on
          (no blink) when active and not submitting; muted when locked. */}
      {submitting ? (
        <Text color={theme['textMuted']}>…</Text>
      ) : (
        <Text inverse> </Text>
      )}
    </Box>
  );
}
