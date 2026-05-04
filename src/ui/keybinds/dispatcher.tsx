import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  /**
   * Append a per-panel command set to the active registry. Returns an
   * unregister function. Re-registering the same `id` replaces the
   * existing command (no duplicate-error from `selectCommands` because
   * dedup happens at lookup time on `id`).
   *
   * Use the `useRegisterCommands` hook below for the React-correct
   * mount/unmount lifecycle.
   */
  registerCommands(commands: readonly Command[]): () => void;
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

  // Phase 3E audit C1: `useState(initialCommands)` only reads the prop
  // ONCE on mount. Phase 3A's all-static-global-commands era never
  // triggered the bug; 3E's dynamic `questions.open` (count + disabled
  // reason flip with the queue) is the first observable failure. Sync
  // the prop into state on every identity change. Merge by id so
  // panel-registered commands (`registerCommands` below) still carry
  // through — panel ids never collide with global ids in practice.
  useEffect(() => {
    setCommands((prev) => {
      const ids = new Set(initialCommands.map((c) => c.id));
      const carried = prev.filter((c) => !ids.has(c.id));
      return [...carried, ...initialCommands];
    });
  }, [initialCommands]);

  const setCommandsCallback = useCallback(
    (next: readonly Command[]) => setCommands(next),
    [],
  );

  const registerCommands = useCallback((toAdd: readonly Command[]): (() => void) => {
    const ids = new Set(toAdd.map((c) => c.id));
    setCommands((prev) => {
      const filtered = prev.filter((c) => !ids.has(c.id));
      return [...filtered, ...toAdd];
    });
    return () => {
      setCommands((prev) => prev.filter((c) => !ids.has(c.id)));
    };
  }, []);

  const active = useMemo(
    () => selectCommands(commands, focus.currentScope, false),
    [commands, focus.currentScope],
  );
  const bar = useMemo(
    () => selectCommands(commands, focus.currentScope, true),
    [commands, focus.currentScope],
  );

  const controller = useMemo<KeybindController>(
    () => ({
      commands,
      active,
      bar,
      setCommands: setCommandsCallback,
      registerCommands,
    }),
    [commands, active, bar, setCommandsCallback, registerCommands],
  );

  // Single root-level key listener. Walks `active` (already filtered by
  // scope) and runs the first matching command's onSelect. Disabled
  // commands are skipped silently — the bottom bar today does NOT render
  // the disabled reason (3E audit m1; track as Phase 3F polish: fade
  // disabled binds + suffix the reason).
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

/**
 * Register a panel-scoped command set for the lifetime of a component.
 * Pass the SAME array reference (memoized via `useMemo`) on every render
 * — re-registration on every render is wasteful but functionally
 * harmless (replaces by id).
 *
 * Use the `enabled` flag to gate registration on focus or other state
 * — when `false`, the commands are unregistered without remounting the
 * component.
 */
export function useRegisterCommands(
  commands: readonly Command[],
  enabled = true,
): void {
  const { registerCommands } = useKeybinds();
  useEffect(() => {
    if (!enabled) return;
    if (commands.length === 0) return;
    return registerCommands(commands);
  }, [registerCommands, commands, enabled]);
}
