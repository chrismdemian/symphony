import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';

/**
 * Focus management for Symphony's TUI.
 *
 * Pattern from lazygit `pkg/gui/context.go:75-203`: focus is a stack,
 * not a flat enum. Tab/Shift+Tab cycle the current "main" context
 * (chat / workers / output). Phase 3E popups push a temporary context
 * onto the same stack — Esc pops back to the previous main.
 *
 * For Phase 3A only `MainContext` exists. The keybind dispatcher reads
 * `currentScope` from this state to dedup global vs per-panel commands
 * (see `keybinds/registry.ts`). Refactor cost in 3E would be significant
 * if we shipped a flat `useState<FocusKey>` here.
 */

export type FocusKey = 'chat' | 'workers' | 'output';

export const FOCUS_CYCLE: readonly FocusKey[] = ['chat', 'workers', 'output'];

export interface MainContext {
  readonly kind: 'main';
  readonly key: FocusKey;
}

export interface PopupContext {
  readonly kind: 'popup';
  readonly key: string;
}

export type FocusContext = MainContext | PopupContext;

export interface FocusState {
  readonly stack: readonly FocusContext[];
}

type Action =
  | { type: 'cycle' }
  | { type: 'cycleReverse' }
  | { type: 'push'; context: FocusContext }
  | { type: 'pop' }
  | { type: 'setMain'; key: FocusKey }
  /**
   * Phase 3F.1 — coalesced "pop popup AND switch the underlying main
   * panel". Required because successive `dispatch({type:'pop'})` then
   * `dispatch({type:'setMain', key})` both read `state.stack` at
   * dispatch time and the second one sees the popup STILL on top
   * (audit M6 makes setMain a no-op while a popup is on top). One
   * action computes the final stack atomically.
   */
  | { type: 'popAndSetMain'; key: FocusKey };

const initialState: FocusState = {
  stack: [{ kind: 'main', key: 'chat' }],
};

function findMain(stack: readonly FocusContext[]): MainContext {
  // The stack always contains exactly one MainContext at the BOTTOM.
  // Popups are pushed on top; they don't displace the main key.
  for (const ctx of stack) {
    if (ctx.kind === 'main') return ctx;
  }
  // Defensive: should never happen because initialState seeds one.
  return { kind: 'main', key: 'chat' };
}

function cycleKey(current: FocusKey, direction: 1 | -1): FocusKey {
  const idx = FOCUS_CYCLE.indexOf(current);
  if (idx === -1) return FOCUS_CYCLE[0]!;
  const nextIdx = (idx + direction + FOCUS_CYCLE.length) % FOCUS_CYCLE.length;
  return FOCUS_CYCLE[nextIdx]!;
}

function isPopupOnTop(stack: readonly FocusContext[]): boolean {
  const top = stack[stack.length - 1];
  return top !== undefined && top.kind === 'popup';
}

function reducer(state: FocusState, action: Action): FocusState {
  switch (action.type) {
    case 'cycle':
    case 'cycleReverse': {
      // Audit M6 (Phase 3A): cycle/setMain are NO-OPS when a popup is
      // on top. Tab inside a popup must not silently swap the panel
      // behind it — popping the popup later would teleport the user.
      // The popup's own key handlers (registered via panel scope) own
      // Tab semantics while open.
      if (isPopupOnTop(state.stack)) return state;
      const direction = action.type === 'cycle' ? 1 : -1;
      const main = findMain(state.stack);
      const nextKey = cycleKey(main.key, direction);
      const nextMain: MainContext = { kind: 'main', key: nextKey };
      return {
        stack: state.stack.map((c) => (c.kind === 'main' ? nextMain : c)),
      };
    }
    case 'setMain': {
      // Audit M6: same rule — setMain is silent while popup is on top.
      if (isPopupOnTop(state.stack)) return state;
      const nextMain: MainContext = { kind: 'main', key: action.key };
      return {
        stack: state.stack.map((c) => (c.kind === 'main' ? nextMain : c)),
      };
    }
    case 'push':
      return { stack: [...state.stack, action.context] };
    case 'pop':
      // Never pop the bottom main context — Esc on chat is a no-op,
      // not "vanish all panels".
      if (state.stack.length <= 1) return state;
      return { stack: state.stack.slice(0, -1) };
    case 'popAndSetMain': {
      const popped =
        state.stack.length <= 1 ? state.stack : state.stack.slice(0, -1);
      const nextMain: MainContext = { kind: 'main', key: action.key };
      return {
        stack: popped.map((c) => (c.kind === 'main' ? nextMain : c)),
      };
    }
  }
}

export interface FocusController {
  readonly state: FocusState;
  /** The currently-focused panel key. If a popup is on top, returns the underlying main key. */
  readonly currentMainKey: FocusKey;
  /** The active scope used by keybind dispatch — popup key if open, else main key. */
  readonly currentScope: string;
  cycle(): void;
  cycleReverse(): void;
  setMain(key: FocusKey): void;
  pushPopup(popupKey: string): void;
  popPopup(): void;
  /**
   * Phase 3F.1 — atomic "pop the popup, then switch underlying main
   * panel to `key`". Use this instead of `popPopup() + setMain(key)`,
   * which would no-op `setMain` because the popup is still on top
   * within a batched render cycle.
   */
  popAndSetMain(key: FocusKey): void;
}

const FocusContextRef = createContext<FocusController | null>(null);

export interface FocusProviderProps {
  readonly initial?: FocusState;
  readonly children: ReactNode;
}

export function FocusProvider({ initial, children }: FocusProviderProps): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initial ?? initialState);
  const cycle = useCallback(() => dispatch({ type: 'cycle' }), []);
  const cycleReverse = useCallback(() => dispatch({ type: 'cycleReverse' }), []);
  const setMain = useCallback((key: FocusKey) => dispatch({ type: 'setMain', key }), []);
  const pushPopup = useCallback(
    (key: string) => dispatch({ type: 'push', context: { kind: 'popup', key } }),
    [],
  );
  const popPopup = useCallback(() => dispatch({ type: 'pop' }), []);
  const popAndSetMain = useCallback(
    (key: FocusKey) => dispatch({ type: 'popAndSetMain', key }),
    [],
  );

  const controller = useMemo<FocusController>(() => {
    const main = findMain(state.stack);
    const top = state.stack[state.stack.length - 1] ?? main;
    return {
      state,
      currentMainKey: main.key,
      currentScope: top.kind === 'popup' ? top.key : main.key,
      cycle,
      cycleReverse,
      setMain,
      pushPopup,
      popPopup,
      popAndSetMain,
    };
  }, [state, cycle, cycleReverse, setMain, pushPopup, popPopup, popAndSetMain]);

  return <FocusContextRef.Provider value={controller}>{children}</FocusContextRef.Provider>;
}

export function useFocus(): FocusController {
  const ctx = useContext(FocusContextRef);
  if (ctx === null) {
    throw new Error('useFocus() called outside <FocusProvider>');
  }
  return ctx;
}
