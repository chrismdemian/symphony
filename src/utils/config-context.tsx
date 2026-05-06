import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyPatchToDisk,
  defaultConfig,
  loadConfig,
  type ConfigSource,
  type SymphonyConfig,
  type SymphonyConfigPatch,
  type SymphonyConfigPatchFn,
} from './config.js';
import { SymphonyConfigSchema } from './config-schema.js';

export type { SymphonyConfigPatch, SymphonyConfigPatchFn } from './config.js';

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
  /**
   * Phase 3H.2 — apply a partial patch, persist via `saveConfig`, and
   * reflect the merged result in component state. Returns the new config.
   * Throws if the merged result fails Zod validation (e.g. integer field
   * out of range) — callers SHOULD wrap and surface a toast on rejection.
   * Tests passing `props.initial` get an in-memory-only setter (no disk
   * I/O) so harness fixtures aren't clobbered.
   *
   * Patch can be a static object OR a function `(current) => patch`.
   * The function form runs INSIDE the serialized disk-write queue,
   * AFTER reading the freshly-committed disk state — closes the
   * rapid-fire stale-render race for chord handlers (`<leader>m m`).
   */
  readonly setConfig: (
    patch: SymphonyConfigPatch | SymphonyConfigPatchFn,
  ) => Promise<SymphonyConfig>;
}

const FALLBACK_SOURCE: ConfigSource = { kind: 'default' } as const;

const FALLBACK_CONTROLLER: ConfigController = {
  config: defaultConfig(),
  source: FALLBACK_SOURCE,
  reload: async () => undefined,
  setConfig: async () => defaultConfig(),
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

  // Phase 3H.2 — `setConfig` routes through the single-writer helper
  // `applyPatchToDisk` (`config.ts`) which serializes ALL config writes
  // within this process via a Promise queue. That serialization closes
  // the read-modify-write race documented in the 3H.2 audit (concurrent
  // setConfig calls clobbering each other through stale state-closure).
  //
  // In test/harness mode (`initial` provided), the disk write is
  // skipped — we mirror the merge + Zod validate locally so the patch
  // shape stays consistent with production but no temp file is touched.
  // The schema parse still throws on out-of-range values so unit tests
  // see the same rejection semantics as production callers.
  // Audit C2: serialize setConfig calls via an inflight ref. Each call
  // awaits the prior's resolved CONFIG value, so a function-patch (or
  // any read of "current state" inside setConfig's body) sees the
  // post-prior-commit value, not a stale React render. The disk-side
  // `applyPatchToDisk` has its own queue that serializes disk reads;
  // this ref handles the in-memory test path AND ensures the React
  // state setter sequences correctly even before commits flush.
  const inflightRef = useRef<Promise<SymphonyConfig>>(Promise.resolve(state.config));
  const setConfig = useCallback(
    async (
      patch: SymphonyConfigPatch | SymphonyConfigPatchFn,
    ): Promise<SymphonyConfig> => {
      const prior = inflightRef.current;
      const result = (async (): Promise<SymphonyConfig> => {
        // Wait for the prior call's resolved config. If the prior
        // rejected, fall back to whatever the current React state
        // closure captured (the safest baseline in that scenario).
        const baseline = await prior.catch(() => state.config);
        let next: SymphonyConfig;
        let nextSource: ConfigSource;
        if (initialOverride) {
          // In-memory-only path for test fixtures. Function-patch
          // resolves against the inflight-chained baseline so two
          // rapid-fire fires read distinct values.
          const resolvedPatch =
            typeof patch === 'function' ? patch(baseline) : patch;
          const merged = applyPatchInMemory(baseline, resolvedPatch);
          next = SymphonyConfigSchema.parse(merged);
          nextSource = state.source;
        } else {
          // Production: pass the patch (function or static) into
          // `applyPatchToDisk`, which reads disk fresh under its own
          // queue and applies the function there. Disk is the source
          // of truth — any concurrent process write reflects.
          const r = await applyPatchToDisk(patch);
          next = r.config;
          nextSource = r.source;
        }
        if (mountedRef.current) {
          setState({ config: next, source: nextSource });
        }
        return next;
      })();
      // Synchronously chain BEFORE the next call captures inflightRef
      // (within the same JS frame, before any await). The catch
      // collapses rejections to the current state baseline so the
      // queue keeps composing on errors.
      inflightRef.current = result.catch(() => state.config);
      return result;
    },
    [state.config, state.source, initialOverride],
  );

  const controller = useMemo<ConfigController>(
    () => ({ config: state.config, source: state.source, reload, setConfig }),
    [state.config, state.source, reload, setConfig],
  );

  return <ConfigContext.Provider value={controller}>{props.children}</ConfigContext.Provider>;
}

/**
 * Test/harness-only merge — production code goes through `applyPatchToDisk`
 * (`config.ts`) which uses the same merge logic plus disk persistence.
 * Mirrors the helper's `mergePatch` so the test path exercises identical
 * patch semantics. Pure; caller pipes through Zod.
 */
function applyPatchInMemory(
  current: SymphonyConfig,
  patch: SymphonyConfigPatch,
): SymphonyConfig {
  const next: SymphonyConfig = { ...current };
  if (patch.modelMode !== undefined) next.modelMode = patch.modelMode;
  if (patch.maxConcurrentWorkers !== undefined) next.maxConcurrentWorkers = patch.maxConcurrentWorkers;
  if (patch.leaderTimeoutMs !== undefined) next.leaderTimeoutMs = patch.leaderTimeoutMs;
  if (patch.notifications !== undefined) {
    next.notifications = { ...current.notifications, ...patch.notifications };
  }
  if (patch.theme !== undefined) {
    next.theme = { ...current.theme, ...patch.theme };
  }
  if (patch.keybindOverrides !== undefined) next.keybindOverrides = patch.keybindOverrides;
  if ('defaultProjectPath' in patch) {
    if (patch.defaultProjectPath === null) {
      delete next.defaultProjectPath;
    } else if (patch.defaultProjectPath !== undefined) {
      next.defaultProjectPath = patch.defaultProjectPath;
    }
  }
  return next;
}

export function useConfig(): ConfigController {
  return useContext(ConfigContext);
}
