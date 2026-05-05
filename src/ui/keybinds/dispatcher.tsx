import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useInput, type Key } from 'ink';
import { useFocus } from '../focus/focus.js';
import {
  formatKey,
  selectCommands,
  simpleChordEquals,
  type Command,
  type KeyChord,
  type SimpleChord,
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
 *
 * Phase 3F.2 — leader-chord plumbing. The dispatcher tracks a
 * `leaderActive: SimpleChord | null` reducer state. A keystroke that
 * matches the LEAD of any leader command arms the leader window; the
 * NEXT keystroke is matched against `second` of every leader command
 * with the same lead, then leader is cleared. 300ms timeout clears the
 * armed state if no second keystroke arrives. While armed, non-leader
 * commands are SUPPRESSED — Ctrl+X then `m` should not also fire some
 * `m`-bound chat command midway.
 */

interface KeybindController {
  readonly commands: readonly Command[];
  /** All commands relevant to the current focus scope (deduped, palette-flavor). */
  readonly active: readonly Command[];
  /** The `Command[]` filtered + deduped for the bottom bar. */
  readonly bar: readonly Command[];
  /** Phase 3F.2 — currently-armed leader lead chord, or null. */
  readonly leaderActive: SimpleChord | null;
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
  /** Phase 3F.2 — leader-window timeout in ms. Default 300; tests pass smaller for fast scenarios. */
  readonly leaderTimeoutMs?: number;
  readonly children: ReactNode;
}

const DEFAULT_LEADER_TIMEOUT_MS = 300;

function chordMatches(
  chord: KeyChord,
  input: string,
  key: Key,
  leaderActive: SimpleChord | null,
): boolean {
  if (chord.kind === 'leader') {
    if (leaderActive === null) return false;
    if (!simpleChordEquals(leaderActive, chord.lead)) return false;
    return simpleChordMatches(chord.second, input, key);
  }
  if (chord.kind === 'none') return false;
  // Non-leader simple chords: only fire when no leader is armed.
  // Otherwise the second-keystroke of a leader chord could double-fire.
  if (leaderActive !== null) return false;
  return simpleChordMatches(chord, input, key);
}

function simpleChordMatches(chord: SimpleChord, input: string, key: Key): boolean {
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

interface LeaderState {
  readonly active: SimpleChord | null;
  readonly armedAt: number;
}

type LeaderAction =
  | { type: 'arm'; lead: SimpleChord; at: number }
  | { type: 'clear' };

function leaderReducer(state: LeaderState, action: LeaderAction): LeaderState {
  switch (action.type) {
    case 'arm':
      return { active: action.lead, armedAt: action.at };
    case 'clear':
      if (state.active === null) return state;
      return { active: null, armedAt: 0 };
  }
}

const INITIAL_LEADER_STATE: LeaderState = { active: null, armedAt: 0 };

export function KeybindProvider({
  initialCommands,
  leaderTimeoutMs = DEFAULT_LEADER_TIMEOUT_MS,
  children,
}: KeybindProviderProps): React.JSX.Element {
  const focus = useFocus();
  const [commands, setCommands] = useState<readonly Command[]>(initialCommands);
  const [leaderState, dispatchLeader] = useReducer(leaderReducer, INITIAL_LEADER_STATE);

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

  // Phase 3F.2 audit C1: leader-active ref is updated SYNCHRONOUSLY
  // inside the `useInput` callback when arming/clearing — NOT via
  // `useEffect` (passive effect, fires after the JS frame returns).
  // Ink's input parser splits `\x18m` (a paste-style two-byte chunk)
  // into TWO synchronous `useInput` calls in one frame. With effect-
  // based mirroring, the second call reads stale `null` and the leader
  // never matches. Synchronous ref writes inside the dispatch path
  // close that race.
  //
  // Reducer is still the React-tracked source of truth for re-renders
  // (KeybindBar reads `leaderState.active` to flip the hint); the ref
  // is purely for cross-keystroke memory inside the same JS frame.
  const leaderActiveRef = useRef<SimpleChord | null>(null);
  // Initial sync on mount — handles tests that pre-seed initial
  // commands but never dispatch.
  if (leaderActiveRef.current !== leaderState.active) {
    leaderActiveRef.current = leaderState.active;
  }

  // Auto-clear the armed leader after `leaderTimeoutMs`. Reads from
  // the reducer state directly; the timer also clears the ref via
  // the dispatch flow (reducer → useEffect-less ref sync above the
  // next render).
  useEffect(() => {
    if (leaderState.active === null) return;
    const handle = setTimeout(() => {
      dispatchLeader({ type: 'clear' });
      leaderActiveRef.current = null;
    }, leaderTimeoutMs);
    return () => clearTimeout(handle);
  }, [leaderState.active, leaderState.armedAt, leaderTimeoutMs]);

  const controller = useMemo<KeybindController>(
    () => ({
      commands,
      active,
      bar,
      leaderActive: leaderState.active,
      setCommands: setCommandsCallback,
      registerCommands,
    }),
    [commands, active, bar, leaderState.active, setCommandsCallback, registerCommands],
  );

  // Single root-level key listener. Walks `active` (already filtered by
  // scope) and runs the first matching command's onSelect. Disabled
  // commands are skipped silently — the bottom bar today does NOT render
  // the disabled reason (3E audit m1; track as Phase 3F polish: fade
  // disabled binds + suffix the reason).
  useInput((input, key) => {
    const armed = leaderActiveRef.current;
    // Phase 3F.2 — first pass: try to fire any command that matches
    // under current armed state.
    for (const cmd of active) {
      if (cmd.disabledReason !== undefined) continue;
      if (chordMatches(cmd.key, input, key, armed)) {
        // Always clear the leader after consuming a leader-second.
        // Sync ref + reducer (audit C1).
        if (armed !== null) {
          leaderActiveRef.current = null;
          dispatchLeader({ type: 'clear' });
        }
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

    // Phase 3F.2 — second pass (only when nothing fired AND no leader
    // was armed): check if this keystroke is the LEAD of any leader
    // command. If yes, arm the leader; the user's second keystroke on
    // the next call will match.
    if (armed === null) {
      for (const cmd of active) {
        if (cmd.disabledReason !== undefined) continue;
        if (cmd.key.kind !== 'leader') continue;
        if (simpleChordMatches(cmd.key.lead, input, key)) {
          // Sync ref BEFORE dispatching the reducer (audit C1) — Ink's
          // parser may fire the second keystroke before React commits.
          leaderActiveRef.current = cmd.key.lead;
          dispatchLeader({ type: 'arm', lead: cmd.key.lead, at: Date.now() });
          return;
        }
      }
    } else {
      // Armed but second-press didn't match any registered leader chord.
      // Clear the leader so the next keystroke isn't a stale second.
      leaderActiveRef.current = null;
      dispatchLeader({ type: 'clear' });
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

// Side-effect-free access to formatKey for components that want to
// render the chord (palette, help overlay, leader hint).
export { formatKey };
