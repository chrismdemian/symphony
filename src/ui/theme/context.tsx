import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { resolveTheme, SYMPHONY_THEME, type Theme, type ThemeJson } from './theme.js';

/**
 * Theme context.
 *
 * Phase 3A shipped a frozen `useMemo` resolution against the locked
 * truecolor palette. Phase 3H.2 lifts to `useState<ThemeJson>` so the
 * AppShell can hot-swap between truecolor and 16-color in response to
 * config changes (`config.theme.autoFallback16Color`, `<leader>t`).
 * The context exposes both the resolved `theme` map (the existing
 * `useTheme()` consumer) AND a `setThemeJson` setter the AppShell drives.
 *
 * Provider order (`App.tsx`):
 *   ThemeProvider → ToastProvider → ConfigProvider → FocusProvider → …
 *
 * Initialization is INTENTIONALLY truecolor-default (audit C1): the
 * provider is leaf-level and config-unaware, so a probe-driven boot
 * default would couple every test that uses `<ThemeProvider>` (no
 * props) to the host's `process.env`. Instead, AppShell owns the
 * probe + swap path: on mount it reads `useConfig().config.theme.
 * autoFallback16Color` and calls `useThemeController().setThemeJson(
 * pickThemeJson(autoFallback))`. Production users see the right
 * palette within microseconds of mount; tests stay env-independent
 * unless they explicitly opt in via the `themeJson` prop.
 */

interface ThemeController {
  readonly theme: Theme;
  readonly themeJson: ThemeJson;
  setThemeJson(json: ThemeJson): void;
}

const ThemeContext = createContext<ThemeController | null>(null);

export interface ThemeProviderProps {
  /**
   * Override the resolved theme directly (tests). When provided, the
   * provider stays in `useState` form but skips the JSON path — the
   * resolved map is held as-is. Useful for harnesses that want to inject
   * a custom resolved palette without rebuilding the JSON.
   */
  readonly theme?: Theme;
  /**
   * Override the theme JSON (production / tests). Defaults to
   * `pickThemeJson(true)` which probes terminal capability at boot and
   * picks truecolor or 16-color accordingly.
   */
  readonly themeJson?: ThemeJson;
  readonly children: ReactNode;
}

export function ThemeProvider({ theme, themeJson, children }: ThemeProviderProps): React.JSX.Element {
  // Initial theme JSON: explicit prop wins; otherwise default to the
  // truecolor `SYMPHONY_THEME`. AppShell flips to 16-color via
  // `setThemeJson` when `config.theme.autoFallback16Color === true`
  // and the probe says so — keeping the env probe out of leaf-level
  // initialization (audit C1).
  const [json, setJson] = useState<ThemeJson>(() => themeJson ?? SYMPHONY_THEME);

  // Resolved cache: invalidates only when the JSON identity changes.
  // The `theme` prop short-circuits: when the harness passed a pre-
  // resolved Theme, use it directly without re-resolving the JSON.
  const resolved = useMemo(() => (theme !== undefined ? theme : resolveTheme(json)), [json, theme]);

  // Skip the dispatch entirely when `next` is identity-equal to the
  // current state. React's setState would Object.is-bail before commit
  // without this, but AppShell's hot-swap effect re-fires this setter
  // on every controller-identity flip (audit M3) — short-circuiting
  // at the ref avoids the dispatch overhead.
  const jsonRef = useRef(json);
  jsonRef.current = json;

  const setThemeJson = useCallback((next: ThemeJson) => {
    if (jsonRef.current === next) return;
    setJson(next);
  }, []);

  const controller = useMemo<ThemeController>(
    () => ({ theme: resolved, themeJson: json, setThemeJson }),
    [resolved, json, setThemeJson],
  );

  return <ThemeContext.Provider value={controller}>{children}</ThemeContext.Provider>;
}

/**
 * Read the resolved Theme map (the common case — every component that
 * renders colored text uses this).
 */
export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error('useTheme() called outside <ThemeProvider>');
  }
  return ctx.theme;
}

/**
 * Phase 3H.2 — read the full theme controller (resolved Theme + the
 * JSON-level setter). AppShell uses this to drive `setThemeJson` from
 * config changes; most components stick with `useTheme()`.
 */
export function useThemeController(): ThemeController {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error('useThemeController() called outside <ThemeProvider>');
  }
  return ctx;
}
