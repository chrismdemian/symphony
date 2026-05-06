import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { defaultConfig, loadConfig, type ConfigSource, type SymphonyConfig } from './config.js';

/**
 * Phase 3H.1 — React context that loads `~/.symphony/config.json` once
 * on App mount and exposes the parsed `SymphonyConfig` + `ConfigSource`
 * to descendants. 3H.2 will add a `setConfig` setter that hot-applies
 * select fields (theme, max workers, model mode) and persists via
 * `saveConfig`.
 *
 * Provider order (`src/ui/App.tsx`):
 *   ThemeProvider → ToastProvider → ConfigProvider → FocusProvider → …
 *
 * `<ConfigProvider>` mounts INSIDE `<ToastProvider>` so it can call
 * `useToast().showToast(...)` to surface load warnings (malformed JSON,
 * out-of-range field values). Mounting outside Toast leaves warnings
 * silent — the user has no signal their config was rejected.
 */

export interface ConfigController {
  readonly config: SymphonyConfig;
  readonly source: ConfigSource;
  /** Re-read the file from disk. Used after `symphony config --edit` round-trips, or by 3H.2 hot-apply. */
  readonly reload: () => Promise<void>;
}

const FALLBACK_SOURCE: ConfigSource = { kind: 'default' } as const;

const FALLBACK_CONTROLLER: ConfigController = {
  config: defaultConfig(),
  source: FALLBACK_SOURCE,
  reload: async () => undefined,
};

const ConfigContext = createContext<ConfigController>(FALLBACK_CONTROLLER);

export interface ConfigProviderProps {
  readonly children: React.ReactNode;
  /**
   * Optional initial value for tests / the visual harness. When provided,
   * the provider skips the initial async load and uses these values
   * synchronously. Production callers omit this and let the provider
   * load from disk.
   */
  readonly initial?: { readonly config: SymphonyConfig; readonly source: ConfigSource };
  /**
   * Optional warning sink. Production wires this to the toast provider's
   * `showToast`; tests pass a spy. Called once per warning string per
   * load. The warning string is already a complete user-facing message.
   */
  readonly onWarning?: (message: string) => void;
}

export function ConfigProvider(props: ConfigProviderProps): React.JSX.Element {
  const [state, setState] = useState<{ config: SymphonyConfig; source: ConfigSource }>(() =>
    props.initial !== undefined
      ? props.initial
      : { config: defaultConfig(), source: FALLBACK_SOURCE },
  );
  const onWarningRef = useRef(props.onWarning);
  useEffect(() => {
    onWarningRef.current = props.onWarning;
  }, [props.onWarning]);

  // Audit-style guard against "still mounted?" sets after async load —
  // mirrors the 3C M1 pattern used elsewhere in the TUI for fire-and-
  // forget RPC hops. The flag flips on unmount; the post-load setState
  // skips on unmounted components.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Initial load. Skipped when `initial` is supplied (tests / visual harness).
  //
  // The `firedRef` guard fires the load-warning toasts EXACTLY ONCE per
  // mount. Without it, the visual harness re-renders (or React 19's
  // StrictMode double-invoke in dev) re-fired the warnings once per
  // render. Symptom found by the 3H.1 skeptical visual review: identical
  // warning text appearing 3 times in the toast tray. The dep on
  // `props.initial` is unchanged so the load path is gated on the
  // initial fixture identity; the ref guards re-fires on dep churn from
  // an inline object literal (`{config, source}` recreated each render).
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    if (props.initial !== undefined) {
      const initialWarnings = props.initial.source.kind === 'file' ? props.initial.source.warnings : [];
      for (const warning of initialWarnings) onWarningRef.current?.(warning);
      return;
    }
    void (async () => {
      const result = await loadConfig();
      if (!mountedRef.current) return;
      setState({ config: result.config, source: result.source });
      const warnings =
        result.source.kind === 'file' ? result.source.warnings : ([] as readonly string[]);
      for (const warning of warnings) onWarningRef.current?.(warning);
    })();
  }, [props.initial]);

  // Tests / visual harness pass `initial`. In that mode, `reload` is a
  // no-op so the SettingsPanel's mount-time `void reload()` doesn't
  // overwrite the test fixture with defaults from disk. Production
  // callers (production App) don't pass `initial` and get the real
  // re-read-from-disk behavior.
  const initialOverride = props.initial !== undefined;
  const reload = useMemo(
    () => async () => {
      if (initialOverride) return;
      const result = await loadConfig();
      if (!mountedRef.current) return;
      setState({ config: result.config, source: result.source });
      const warnings =
        result.source.kind === 'file' ? result.source.warnings : ([] as readonly string[]);
      for (const warning of warnings) onWarningRef.current?.(warning);
    },
    [initialOverride],
  );

  const controller = useMemo<ConfigController>(
    () => ({ config: state.config, source: state.source, reload }),
    [state.config, state.source, reload],
  );

  return <ConfigContext.Provider value={controller}>{props.children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigController {
  return useContext(ConfigContext);
}
