import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Phase 3F.2 — non-blocking toast queue.
 *
 * Used primarily by leader-key stub commands to flash "Switch model
 * mode (3H wires real action)" and similar feedback when the user
 * fires `<Ctrl+X> m` / `<leader> p` / etc. before the underlying
 * actions land.
 *
 * Default lifetime: 2000ms. Each toast renders one line in the
 * `<ToastTray/>` (mounted by Layout above the KeybindBar). Queue cap
 * is 3 — older toasts get bumped if the user fires a fourth before
 * the first dismisses.
 */

const MAX_TOASTS = 3;
const DEFAULT_TTL_MS = 2000;

export interface Toast {
  readonly id: number;
  readonly message: string;
  readonly tone: 'info' | 'success' | 'warning' | 'error';
}

export interface ToastController {
  readonly toasts: readonly Toast[];
  showToast(message: string, opts?: { readonly tone?: Toast['tone']; readonly ttlMs?: number }): void;
}

const ToastContext = createContext<ToastController | null>(null);

let nextId = 1;

export interface ToastProviderProps {
  readonly children: ReactNode;
  /** Test seam — defaults to 2000 ms; tests pass small ttls for fast scenarios. */
  readonly defaultTtlMs?: number;
}

export function ToastProvider({
  children,
  defaultTtlMs = DEFAULT_TTL_MS,
}: ToastProviderProps): React.JSX.Element {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const timersRef = useRef<Map<number, NodeJS.Timeout>>(new Map());

  // Ensure timers are cleaned up on unmount (test harness mount cycles
  // would otherwise leak intervals).
  useEffect(() => {
    return () => {
      for (const handle of timersRef.current.values()) clearTimeout(handle);
      timersRef.current.clear();
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timersRef.current.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message: string, opts?: { readonly tone?: Toast['tone']; readonly ttlMs?: number }) => {
      const id = nextId++;
      const tone = opts?.tone ?? 'info';
      const ttl = opts?.ttlMs ?? defaultTtlMs;
      const toast: Toast = { id, message, tone };
      // Phase 3F.2 audit M2: state updater MUST stay pure under
      // concurrent rendering — React may invoke it twice. Compute
      // (and stash) the dropped id WITHOUT mutating refs inside the
      // setter; clear the dropped timer in the synchronous code path
      // immediately after.
      let droppedId: number | null = null;
      setToasts((prev) => {
        const next = [...prev, toast];
        if (next.length > MAX_TOASTS) {
          const dropped = next.shift();
          if (dropped !== undefined) droppedId = dropped.id;
        }
        return next;
      });
      if (droppedId !== null) {
        const h = timersRef.current.get(droppedId);
        if (h !== undefined) {
          clearTimeout(h);
          timersRef.current.delete(droppedId);
        }
      }
      const handle = setTimeout(() => {
        dismiss(id);
      }, ttl);
      timersRef.current.set(id, handle);
    },
    [defaultTtlMs, dismiss],
  );

  const controller = useMemo<ToastController>(
    () => ({ toasts, showToast }),
    [toasts, showToast],
  );

  return <ToastContext.Provider value={controller}>{children}</ToastContext.Provider>;
}

// Phase 3F.2 audit M3: hoist the lenient fallback to a frozen
// module-scope singleton so consumers' useMemo/useEffect dep arrays
// don't thrash when a component renders outside the provider tree
// (test harnesses, embedded snapshots, etc.).
const NOOP_CONTROLLER: ToastController = Object.freeze({
  toasts: Object.freeze([]) as readonly Toast[],
  showToast: () => undefined,
});

export function useToast(): ToastController {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    return NOOP_CONTROLLER;
  }
  return ctx;
}
