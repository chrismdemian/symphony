import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../theme/context.js';
import {
  EMPTY_BUFFER,
  bufferText,
  deleteBack,
  deleteForward,
  end,
  home,
  insertChunk,
  insertNewline,
  isEmpty,
  killToEnd,
  killToStart,
  killWordBack,
  moveDown,
  moveLeft,
  moveRight,
  moveUp,
  type InputBuffer,
} from './InputBuffer.js';

/**
 * Multi-line text input bar.
 *
 * Coexists with the keybind dispatcher's root `useInput` (3A): the
 * dispatcher's listener walks `active` commands and matches Tab / Esc /
 * Ctrl+C / etc. — `useInput` handlers run in PARALLEL, so this component
 * uses a positive whitelist (Plan-agent Q3): only consumes keys it
 * explicitly handles. Tab / Esc / Ctrl+C / Ctrl+R / Ctrl+P / etc. flow
 * through to the dispatcher untouched.
 *
 * Keybinds:
 *   - Enter            → submit (if non-empty)
 *   - Shift+Enter      → newline (only on terminals where Ink decodes the
 *                        modifier — kitty keyboard mode in 3B.3)
 *   - Ctrl+J           → newline (UNIVERSAL fallback — works everywhere)
 *   - Backspace        → delete previous char / join lines
 *   - Delete           → delete next char / join with next line
 *   - Arrows           → move cursor
 *   - Home / End       → line start / end
 *   - Ctrl+A / Ctrl+E  → emacs line start / end
 *   - Ctrl+K           → kill-to-end-of-line
 *   - Ctrl+U           → kill-to-start-of-line
 *   - Ctrl+W           → kill word back
 *
 * Pasted text arrives via `usePaste` (3B.2) on a separate channel —
 * embedded `\n` survives there as real line breaks. Until 3B.2 lands,
 * Ink decodes paste bytes through `useInput` chunked, and embedded
 * newlines pass through `insertChunk`.
 */

export interface InputBarProps {
  /** Called with the buffer text when the user presses Enter. Trimmed-empty submits are silently dropped. */
  readonly onSubmit: (text: string) => void;
  /** Disable keystroke handling (e.g., chat panel not focused). Default true. */
  readonly isActive?: boolean;
  /** Placeholder shown when the buffer is empty. */
  readonly placeholder?: string;
}

export function InputBar({
  onSubmit,
  isActive = true,
  placeholder = 'Tell Maestro what to do…',
}: InputBarProps): React.JSX.Element {
  const theme = useTheme();
  const [buf, setBuf] = useState<InputBuffer>(EMPTY_BUFFER);

  useInput(
    (input, key) => {
      // Shift+Enter (kitty mode in 3B.3) — newline.
      if (key.return && key.shift) {
        setBuf(insertNewline);
        return;
      }
      // Plain Enter — submit.
      if (key.return && !key.ctrl && !key.meta) {
        const text = bufferText(buf);
        if (text.trim().length === 0) return;
        onSubmit(text);
        setBuf(EMPTY_BUFFER);
        return;
      }
      // Ctrl+J — universal newline fallback.
      if (key.ctrl && input === 'j') {
        setBuf(insertNewline);
        return;
      }
      // Emacs-style line edits.
      if (key.ctrl && input === 'a') {
        setBuf(home);
        return;
      }
      if (key.ctrl && input === 'e') {
        setBuf(end);
        return;
      }
      if (key.ctrl && input === 'k') {
        setBuf(killToEnd);
        return;
      }
      if (key.ctrl && input === 'u') {
        setBuf(killToStart);
        return;
      }
      if (key.ctrl && input === 'w') {
        setBuf(killWordBack);
        return;
      }

      // Cursor moves.
      if (key.leftArrow) {
        setBuf(moveLeft);
        return;
      }
      if (key.rightArrow) {
        setBuf(moveRight);
        return;
      }
      if (key.upArrow) {
        setBuf(moveUp);
        return;
      }
      if (key.downArrow) {
        setBuf(moveDown);
        return;
      }
      if (key.home) {
        setBuf(home);
        return;
      }
      if (key.end) {
        setBuf(end);
        return;
      }

      // Edits.
      if (key.backspace) {
        setBuf(deleteBack);
        return;
      }
      if (key.delete) {
        setBuf(deleteForward);
        return;
      }

      // Audit M5: negative whitelist on `key.*` flags before insert.
      // Without this, unrecognized escape sequences (PageUp/Down on
      // some terminals, function keys, paste-bracket markers Ink
      // doesn't decode) fall through `input.length >= 1` and inject
      // raw `[5~`-style garbage into the buffer.
      if (
        key.tab ||
        key.escape ||
        key.ctrl ||
        key.meta ||
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        key.pageUp ||
        key.pageDown ||
        key.home ||
        key.end ||
        key.return ||
        key.backspace ||
        key.delete
      ) {
        return;
      }

      // Typed printable characters (or chunk if Ink decoded a paste
      // burst through useInput before 3B.2's usePaste lands).
      if (input.length >= 1) {
        setBuf((b) => insertChunk(b, input));
      }
    },
    { isActive },
  );

  const showPlaceholder = isEmpty(buf);
  const borderColor = isActive ? theme['borderActive'] : theme['border'];

  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      flexDirection="column"
      flexShrink={0}
    >
      {showPlaceholder ? (
        <Text color={theme['textMuted']} dimColor>
          {placeholder}
        </Text>
      ) : (
        buf.lines.map((line, i) => (
          <InputLine key={i} line={line} cursor={isActive && i === buf.row ? buf.col : -1} />
        ))
      )}
    </Box>
  );
}

interface InputLineProps {
  readonly line: string;
  /** Cursor column on this line, or -1 to render plain. */
  readonly cursor: number;
}

function InputLine({ line, cursor }: InputLineProps): React.JSX.Element {
  if (cursor === -1) {
    return <Text>{line.length === 0 ? ' ' : line}</Text>;
  }
  // Render with the cursor at index `cursor`. Past-end-of-line cursors
  // render an inverse space.
  const before = line.slice(0, cursor);
  const at = line.slice(cursor, cursor + 1) || ' ';
  const after = line.slice(cursor + 1);
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}
