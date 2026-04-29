import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useInput, type Key } from 'ink';
import { useFocus } from '../focus/focus.js';
import {
  selectCommands,
  type Command,
  type KeyChord,
} from './registry.js';

/**
 * Keybind dispatcher.
 *
 * Wraps Ink's `useInput` once at the root. Commands are pulled from the
 * registry context and matched against the incoming keystroke. Per-scope
 * commands win over global on the same key (`selectCommands`).
 *
 * Audit M2 (Phase 3A): commands are stored in `useState` (not `useRef +
 * force()`) so React tracks identity natively and downstream `useMemo`
 * dep arrays work without footguns. Phase 3F's command-palette
 * registration calls `setCommands(next)` to swap the active set.
 */

interface KeybindController {
  readonly commands: readonly Command[];
  /** All commands relevant to the current focus scope (deduped, palette-flavor). */
  readonly active: readonly Command[];
  /** The `Command[]` filtered + deduped for the bottom bar. */
  readonly bar: readonly Command[];
  setCommands(commands: readonly Command[]): void;
}

const KeybindContext = createContext<KeybindController | null>(null);

export interface KeybindProviderProps {
  /** Initial command set. Tests can override; production seeds from `defaultCommands`. */
  readonly initialCommands: readonly Command[];
  readonly children: ReactNode;
}

function chordMatches(chord: KeyChord, input: string, key: Key): boolean {
  switch (chord.kind) {
    case 'tab':
      return key.tab && key.shift === (chord.shift === true);
    case 'escape':
      return key.escape;
    case 'return':
      return key.return;
    case 'leftArrow':
      return key.leftArrow;
    case 'rightArrow':
      return key.rightArrow;
    case 'upArrow':
      return key.upArrow;
    case 'downArrow':
      return key.downArrow;
    case 'pageUp':
      return key.pageUp;
    case 'pageDown':
      return key.pageDown;
    case 'ctrl':
      return key.ctrl && input.toLowerCase() === chord.char.toLowerCase();
    case 'char':
      return !key.ctrl && !key.meta && input === chord.char;
  }
}

export function KeybindProvider({
  initialCommands,
  children,
}: KeybindProviderProps): React.JSX.Element {
  const focus = useFocus();
  const [commands, setCommands] = useState<readonly Command[]>(initialCommands);

  const setCommandsCallback = useCallback(
    (next: readonly Command[]) => setCommands(next),
    [],
  );

  const active = useMemo(
    () => selectCommands(commands, focus.currentScope, false),
    [commands, focus.currentScope],
  );
  const bar = useMemo(
    () => selectCommands(commands, focus.currentScope, true),
    [commands, focus.currentScope],
  );

  const controller = useMemo<KeybindController>(
    () => ({ commands, active, bar, setCommands: setCommandsCallback }),
    [commands, active, bar, setCommandsCallback],
  );

  // Single root-level key listener. Walks `active` (already filtered by
  // scope) and runs the first matching command's onSelect. Disabled
  // commands are skipped silently — the bar already renders the reason.
  useInput((input, key) => {
    for (const cmd of active) {
      if (cmd.disabledReason !== undefined) continue;
      if (chordMatches(cmd.key, input, key)) {
        // Fire-and-forget; errors land in the unhandled-promise stream.
        // Wrap to avoid unhandled rejections in dev.
        const result = cmd.onSelect();
        if (result instanceof Promise) {
          result.catch((err) => {
            process.stderr.write(
              `[keybinds] command "${cmd.id}" failed: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          });
        }
        return;
      }
    }
  });

  return <KeybindContext.Provider value={controller}>{children}</KeybindContext.Provider>;
}

export function useKeybinds(): KeybindController {
  const ctx = useContext(KeybindContext);
  if (ctx === null) {
    throw new Error('useKeybinds() called outside <KeybindProvider>');
  }
  return ctx;
}
