import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';

/**
 * Selection state for the workers panel (Phase 3C).
 *
 * Lives ABOVE the panel so Phase 3D's output panel can read the same
 * `selectedId` without prop-drilling and 3F's command palette can call
 * `selectByOrdinal` without coupling to panel internals.
 *
 * Reconciliation rule: when the visible-id list changes, if the current
 * `selectedId` is no longer present, the selection clears (or falls
 * back to the first visible id when one exists). The reducer is driven
 * from the panel via `reconcile(visibleIds)` — pure, no timers, no
 * async.
 *
 * Implementation note: cycling actions go through `useReducer` so they
 * read CURRENT state at dispatch time. A previous `useRef` mirror
 * pattern raced Ink's render scheduler — `setImmediate` flushed the
 * commit but not the ref-update effect, so back-to-back `cyclePrev`
 * calls in tests saw a stale id.
 */

type State = {
  readonly selectedId: string | null;
};

type Action =
  | { kind: 'set'; id: string | null }
  | { kind: 'reconcile'; visibleIds: readonly string[] }
  | { kind: 'cyclePrev'; visibleIds: readonly string[] }
  | { kind: 'cycleNext'; visibleIds: readonly string[] }
  | { kind: 'selectByOrdinal'; visibleIds: readonly string[]; ordinal: number };

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case 'set':
      if (state.selectedId === action.id) return state;
      return { selectedId: action.id };
    case 'reconcile': {
      if (action.visibleIds.length === 0) {
        return state.selectedId === null ? state : { selectedId: null };
      }
      if (state.selectedId === null) return { selectedId: action.visibleIds[0]! };
      if (action.visibleIds.includes(state.selectedId)) return state;
      return { selectedId: action.visibleIds[0]! };
    }
    case 'cyclePrev': {
      const ids = action.visibleIds;
      if (ids.length === 0) return state;
      if (state.selectedId === null) {
        return { selectedId: ids[ids.length - 1]! };
      }
      const idx = ids.indexOf(state.selectedId);
      if (idx === -1) return { selectedId: ids[0]! };
      const prevIdx = (idx - 1 + ids.length) % ids.length;
      return { selectedId: ids[prevIdx]! };
    }
    case 'cycleNext': {
      const ids = action.visibleIds;
      if (ids.length === 0) return state;
      if (state.selectedId === null) return { selectedId: ids[0]! };
      const idx = ids.indexOf(state.selectedId);
      if (idx === -1) return { selectedId: ids[0]! };
      const nextIdx = (idx + 1) % ids.length;
      return { selectedId: ids[nextIdx]! };
    }
    case 'selectByOrdinal': {
      const { visibleIds: ids, ordinal } = action;
      if (!Number.isInteger(ordinal) || ordinal < 1) return state;
      const idx = ordinal - 1;
      if (idx >= ids.length) return state;
      return { selectedId: ids[idx]! };
    }
  }
}

export interface WorkerSelectionController {
  readonly selectedId: string | null;
  setSelectedId(id: string | null): void;
  /**
   * Update selection against the current ORDERED list of visible
   * worker ids. If the current selection has dropped out, fall back
   * to the first visible id, or null if the list is empty.
   */
  reconcile(visibleIds: readonly string[]): void;
  cyclePrev(visibleIds: readonly string[]): void;
  cycleNext(visibleIds: readonly string[]): void;
  /** 1-indexed ordinal — `selectByOrdinal(1)` selects the first visible worker. */
  selectByOrdinal(visibleIds: readonly string[], ordinal: number): void;
}

const WorkerSelectionContext = createContext<WorkerSelectionController | null>(null);

export interface WorkerSelectionProviderProps {
  readonly initialSelectedId?: string | null;
  readonly children: ReactNode;
}

export function WorkerSelectionProvider({
  initialSelectedId,
  children,
}: WorkerSelectionProviderProps): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, { selectedId: initialSelectedId ?? null });

  const setSelectedId = useCallback((id: string | null) => {
    dispatch({ kind: 'set', id });
  }, []);
  const reconcile = useCallback((visibleIds: readonly string[]) => {
    dispatch({ kind: 'reconcile', visibleIds });
  }, []);
  const cyclePrev = useCallback((visibleIds: readonly string[]) => {
    dispatch({ kind: 'cyclePrev', visibleIds });
  }, []);
  const cycleNext = useCallback((visibleIds: readonly string[]) => {
    dispatch({ kind: 'cycleNext', visibleIds });
  }, []);
  const selectByOrdinal = useCallback(
    (visibleIds: readonly string[], ordinal: number) => {
      dispatch({ kind: 'selectByOrdinal', visibleIds, ordinal });
    },
    [],
  );

  const controller = useMemo<WorkerSelectionController>(
    () => ({
      selectedId: state.selectedId,
      setSelectedId,
      reconcile,
      cyclePrev,
      cycleNext,
      selectByOrdinal,
    }),
    [state.selectedId, setSelectedId, reconcile, cyclePrev, cycleNext, selectByOrdinal],
  );

  return (
    <WorkerSelectionContext.Provider value={controller}>
      {children}
    </WorkerSelectionContext.Provider>
  );
}

export function useWorkerSelection(): WorkerSelectionController {
  const ctx = useContext(WorkerSelectionContext);
  if (ctx === null) {
    throw new Error('useWorkerSelection() called outside <WorkerSelectionProvider>');
  }
  return ctx;
}
