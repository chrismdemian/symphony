import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../../theme/context.js';
import { useFocus } from '../../focus/focus.js';
import { useRegisterCommands } from '../../keybinds/dispatcher.js';
import type { Command } from '../../keybinds/registry.js';
import { useConfig } from '../../../utils/config-context.js';
import { useToast } from '../../feedback/ToastProvider.js';
import { usePlugins } from '../../data/usePlugins.js';
import type { TuiRpc } from '../../runtime/rpc.js';
import type { PluginListItem } from '../../../rpc/router-impl.js';

/**
 * Phase 7C — Plugins management popup.
 *
 * Lists installed plugins (read over RPC from the shared SQLite registry)
 * and lets the user:
 *   - toggle the `pluginsEnabled` MASTER switch (config, in-process via
 *     `setConfig` — same path as SettingsPanel),
 *   - enable/disable a single plugin (RPC `plugins.setEnabled`),
 *   - install a plugin from a path / npm spec / git URL (RPC
 *     `plugins.install`, always ignore-scripts),
 *   - remove a plugin (RPC `plugins.remove`, behind an Enter/Esc confirm).
 *
 * ALL mutations are restart-required (the plugin host loads enabled
 * plugins at orchestrator-server boot — no live hot-reload). The footer
 * states this; every success toast says "applies on restart".
 *
 * Layout + interaction model mirror `SettingsPanel` (popup-scope
 * `'plugins'`, internal nav commands, ref-mirror selection state to dodge
 * the 3F.1 registry-mutation feedback loop, a raw `useInput` that
 * accumulates the install-source buffer in parallel with the dispatcher).
 */

const SCOPE = 'plugins';
const VISIBLE_ROWS = 14;
/** RPC `plugins.install` source string cap (mirrors the router boundary). */
const SOURCE_MAX = 2 * 1024;

/**
 * Capability flags that carry real risk — rendered in the warning tone so
 * the user notices before enabling. Deliberately NARROW: only the
 * `requires:*` host/secrets/network flags (which grant access to the
 * user's machine/credentials and need explicit intent) get the warning
 * tone. `irreversible` / `external-visible` are ordinary capability
 * markers and stay muted, so a genuinely dangerous flag stands out next to
 * them instead of every flag blurring into one warning-colored run.
 */
const DANGEROUS_FLAGS: ReadonlySet<string> = new Set([
  'requires:host-browser-control',
  'requires:network-egress',
  'requires:secrets-read',
]);

type Row =
  | { readonly kind: 'master' }
  | { readonly kind: 'plugin'; readonly plugin: PluginListItem };

type Mode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'installing'; readonly value: string }
  | { readonly kind: 'confirming-remove'; readonly id: string };

export interface PluginsPanelProps {
  readonly rpc: TuiRpc;
}

export function PluginsPanel({ rpc }: PluginsPanelProps): React.JSX.Element {
  const theme = useTheme();
  const focus = useFocus();
  const { config, setConfig } = useConfig();
  const { showToast } = useToast();
  const { plugins, loading, error, refresh } = usePlugins(rpc);
  const isFocused = focus.currentScope === SCOPE;

  const rows = useMemo<readonly Row[]>(
    () => [{ kind: 'master' as const }, ...plugins.map((p) => ({ kind: 'plugin' as const, plugin: p }))],
    [plugins],
  );

  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: 'idle' });

  const rowsRef = useRef(rows);
  const selectedIdxRef = useRef(selectedIdx);
  const modeRef = useRef(mode);
  // Mutex over in-flight async mutations (RPC enable/disable/install/
  // remove). Mirrors SettingsPanel's committingRef: while busy, the
  // dispatcher's action commands no-op so a double-press can't fire two
  // parallel mutations, and the raw input drops chars.
  const busyRef = useRef(false);
  // Guards fire-and-forget setState after the popup closes (3C/3J).
  const unmountedRef = useRef(false);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    selectedIdxRef.current = selectedIdx;
  }, [selectedIdx]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Clamp selection when the list shrinks (e.g. after a remove).
  useEffect(() => {
    setSelectedIdx((idx) => (idx > rows.length - 1 ? Math.max(0, rows.length - 1) : idx));
  }, [rows.length]);

  const popPopup = focus.popPopup;

  const move = useCallback((delta: 1 | -1): void => {
    const list = rowsRef.current;
    if (list.length === 0) return;
    setSelectedIdx((idx) => {
      const start = Math.min(Math.max(idx, 0), list.length - 1);
      return (start + delta + list.length) % list.length;
    });
  }, []);

  // Toggle the pluginsEnabled master switch via setConfig function-patch
  // (3H.2 audit-C2: rapid-fire toggles must read the just-committed state).
  const toggleMaster = useCallback((): void => {
    void (async () => {
      try {
        const next = await setConfig((current) => ({ pluginsEnabled: !current.pluginsEnabled }));
        showToast(
          `Plugins ${next.pluginsEnabled ? 'enabled' : 'disabled'} (master) — applies on restart.`,
          { tone: 'info' },
        );
      } catch (err) {
        showToast(`Invalid: ${err instanceof Error ? err.message : String(err)}`, { tone: 'error' });
      }
    })();
  }, [setConfig, showToast]);

  // Enable/disable a single plugin over RPC, then refetch.
  const togglePlugin = useCallback(
    (plugin: PluginListItem): void => {
      if (busyRef.current) return;
      busyRef.current = true;
      const target = !plugin.enabled;
      void rpc.call.plugins
        .setEnabled({ id: plugin.id, enabled: target })
        .then(() => {
          if (unmountedRef.current) return;
          showToast(
            `${target ? 'Enabled' : 'Disabled'} '${plugin.id}' — applies on restart.`,
            { tone: 'info' },
          );
          refresh();
        })
        .catch((err: unknown) => {
          if (unmountedRef.current) return;
          showToast(
            `${target ? 'Enable' : 'Disable'} failed: ${err instanceof Error ? err.message : String(err)}`,
            { tone: 'error' },
          );
        })
        .finally(() => {
          busyRef.current = false;
        });
    },
    [rpc, showToast, refresh],
  );

  const toggleSelected = useCallback((): void => {
    const row = rowsRef.current[selectedIdxRef.current];
    if (row === undefined) return;
    if (row.kind === 'master') {
      toggleMaster();
    } else {
      togglePlugin(row.plugin);
    }
  }, [toggleMaster, togglePlugin]);

  const startInstall = useCallback((): void => {
    setMode({ kind: 'installing', value: '' });
  }, []);

  const startRemove = useCallback((): void => {
    const row = rowsRef.current[selectedIdxRef.current];
    if (row === undefined || row.kind !== 'plugin') {
      showToast('Select a plugin row to remove (the master switch can only be toggled).', {
        tone: 'info',
      });
      return;
    }
    setMode({ kind: 'confirming-remove', id: row.plugin.id });
  }, [showToast]);

  const submitInstall = useCallback((): void => {
    if (busyRef.current) return;
    const current = modeRef.current;
    if (current.kind !== 'installing') return;
    const source = current.value.trim();
    if (source.length === 0) {
      showToast('Empty source — aborted.', { tone: 'warning' });
      setMode({ kind: 'idle' });
      return;
    }
    busyRef.current = true;
    void rpc.call.plugins
      .install({ source })
      .then((res) => {
        if (unmountedRef.current) return;
        showToast(
          `Installed '${res.id}' (${res.version}) — disabled by default; enable it, then restart.`,
          { tone: 'info', ttlMs: 5_000 },
        );
        setMode({ kind: 'idle' });
        refresh();
      })
      .catch((err: unknown) => {
        if (unmountedRef.current) return;
        showToast(`Install failed: ${err instanceof Error ? err.message : String(err)}`, {
          tone: 'error',
          ttlMs: 5_000,
        });
        // Keep the editor open so the user can fix the source.
      })
      .finally(() => {
        busyRef.current = false;
      });
  }, [rpc, showToast, refresh]);

  const confirmRemove = useCallback((): void => {
    if (busyRef.current) return;
    const current = modeRef.current;
    if (current.kind !== 'confirming-remove') return;
    const id = current.id;
    busyRef.current = true;
    void rpc.call.plugins
      .remove({ id })
      .then(() => {
        if (unmountedRef.current) return;
        showToast(`Removed '${id}'.`, { tone: 'info' });
        setMode({ kind: 'idle' });
        refresh();
      })
      .catch((err: unknown) => {
        if (unmountedRef.current) return;
        showToast(`Remove failed: ${err instanceof Error ? err.message : String(err)}`, {
          tone: 'error',
        });
        setMode({ kind: 'idle' });
      })
      .finally(() => {
        busyRef.current = false;
      });
  }, [rpc, showToast, refresh]);

  const cancelMode = useCallback((): void => {
    if (busyRef.current) return;
    setMode({ kind: 'idle' });
  }, []);

  const popupCommands = useMemo<readonly Command[]>(
    () => [
      {
        id: 'plugins.dismiss',
        title: 'close',
        key: { kind: 'escape' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          if (modeRef.current.kind === 'idle') popPopup();
          else cancelMode();
        },
      },
      {
        id: 'plugins.next',
        title: 'next',
        key: { kind: 'downArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          if (modeRef.current.kind === 'idle') move(1);
        },
      },
      {
        id: 'plugins.prev',
        title: 'prev',
        key: { kind: 'upArrow' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          if (modeRef.current.kind === 'idle') move(-1);
        },
      },
      {
        id: 'plugins.invoke',
        title: 'confirm',
        key: { kind: 'return' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          if (busyRef.current) return;
          const m = modeRef.current;
          if (m.kind === 'installing') submitInstall();
          else if (m.kind === 'confirming-remove') confirmRemove();
          else toggleSelected();
        },
      },
      {
        id: 'plugins.toggle',
        title: 'toggle',
        key: { kind: 'char', char: ' ' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          if (modeRef.current.kind === 'idle' && !busyRef.current) toggleSelected();
        },
      },
      {
        id: 'plugins.install',
        title: 'install',
        key: { kind: 'char', char: 'i' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          if (modeRef.current.kind === 'idle' && !busyRef.current) startInstall();
        },
      },
      {
        id: 'plugins.remove',
        title: 'remove',
        key: { kind: 'char', char: 'x' },
        scope: SCOPE,
        displayOnScreen: false,
        internal: true,
        onSelect: () => {
          if (modeRef.current.kind === 'idle' && !busyRef.current) startRemove();
        },
      },
    ],
    [popPopup, cancelMode, move, submitInstall, confirmRemove, toggleSelected, startInstall, startRemove],
  );

  useRegisterCommands(popupCommands, isFocused);

  // Raw input handler for the install-source buffer. Runs in PARALLEL with
  // the dispatcher (which owns Enter/Esc/arrows + the idle action chars);
  // this only accumulates printable chars while installing. Mirrors
  // SettingsPanel's edit-mode useInput (negative whitelist incl. home/end
  // per 3F.1 M4 / 3H.2 audit-C1).
  useInput(
    (input, key) => {
      if (busyRef.current) return;
      if (modeRef.current.kind !== 'installing') return;
      if (key.ctrl && input === 'u') {
        setMode((prev) => (prev.kind === 'installing' ? { ...prev, value: '' } : prev));
        return;
      }
      if (key.backspace || key.delete) {
        setMode((prev) => (prev.kind === 'installing' ? { ...prev, value: prev.value.slice(0, -1) } : prev));
        return;
      }
      if (
        key.return ||
        key.escape ||
        key.upArrow ||
        key.downArrow ||
        key.leftArrow ||
        key.rightArrow ||
        key.tab ||
        key.pageUp ||
        key.pageDown ||
        key.home ||
        key.end ||
        key.ctrl ||
        key.meta
      ) {
        return;
      }
      if (input.length === 0) return;
      setMode((prev) => {
        if (prev.kind !== 'installing') return prev;
        const next = (prev.value + input).slice(0, SOURCE_MAX);
        return { ...prev, value: next };
      });
    },
    { isActive: isFocused && mode.kind === 'installing' },
  );

  const visible = useMemo(() => sliceVisible(rows, selectedIdx), [rows, selectedIdx]);

  const footerHint = useMemo(() => {
    if (mode.kind === 'installing') return 'Type source · Enter install · Esc cancel · Backspace delete';
    if (mode.kind === 'confirming-remove') return 'Enter confirm remove · Esc cancel';
    return '↑↓ navigate · Space toggle · i install · x remove · Esc close';
  }, [mode.kind]);

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor={theme['accent']}
      paddingX={1}
    >
      <Box flexDirection="row">
        <Text color={theme['accent']} bold>
          Plugins
        </Text>
        <Text color={theme['textMuted']}> · manage installed plugins</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {visible.rows.map((row, offset) => {
          const absoluteIdx = visible.start + offset;
          const isSelected = absoluteIdx === selectedIdx;
          if (row.kind === 'master') {
            return (
              <MasterRow
                key="master"
                enabled={config.pluginsEnabled}
                selected={isSelected}
                theme={theme}
              />
            );
          }
          return (
            <PluginRow
              key={`plugin-${row.plugin.id}`}
              plugin={row.plugin}
              selected={isSelected}
              theme={theme}
            />
          );
        })}
        {plugins.length === 0 && !loading ? (
          <Box marginTop={1}>
            <Text color={theme['textMuted']}>No plugins installed. Press i to install one.</Text>
          </Box>
        ) : null}
        {loading && plugins.length === 0 ? (
          <Box marginTop={1}>
            <Text color={theme['textMuted']}>Loading…</Text>
          </Box>
        ) : null}
        {error !== null ? (
          <Box marginTop={1}>
            <Text color={theme['error']}>Failed to load plugins: {error.message}</Text>
          </Box>
        ) : null}
      </Box>

      {mode.kind === 'installing' ? (
        <Box flexDirection="row" marginTop={1}>
          <Text color={theme['textMuted']}>Install source: </Text>
          <Text color={theme['accent']}>{mode.value}</Text>
          <Text color={theme['accent']} inverse>
            {' '}
          </Text>
        </Box>
      ) : null}
      {mode.kind === 'confirming-remove' ? (
        <Box flexDirection="row" marginTop={1}>
          <Text color={theme['error']}>Remove plugin '</Text>
          <Text color={theme['error']} bold>
            {mode.id}
          </Text>
          <Text color={theme['error']}>'? This deletes it from disk.</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme['textMuted']}>{footerHint}</Text>
      </Box>
    </Box>
  );
}

function MasterRow({
  enabled,
  selected,
  theme,
}: {
  readonly enabled: boolean;
  readonly selected: boolean;
  readonly theme: Record<string, string>;
}): React.JSX.Element {
  const marker = selected ? '▸ ' : '  ';
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" width="100%">
        <Text color={selected ? theme['accent'] : theme['textMuted']}>{marker}</Text>
        <Text color={theme['text']}>Plugins enabled (master switch)</Text>
        <Box flexGrow={1} />
        <Text color={enabled ? theme['success'] : theme['textMuted']}>
          {enabled ? 'on' : 'off'}
        </Text>
      </Box>
      {selected ? (
        <Box flexDirection="row" width="100%">
          <Text color={theme['textMuted']}>
            {'    '}
            Off = no plugins load even if individually enabled. Applies on restart.
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function PluginRow({
  plugin,
  selected,
  theme,
}: {
  readonly plugin: PluginListItem;
  readonly selected: boolean;
  readonly theme: Record<string, string>;
}): React.JSX.Element {
  const marker = selected ? '▸ ' : '  ';
  const stateGlyph = plugin.enabled ? '✓ enabled' : '○ disabled';
  const stateColor = plugin.enabled ? theme['success'] : theme['textMuted'];
  const broken = plugin.manifestError !== undefined;
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" width="100%">
        <Text color={selected ? theme['accent'] : theme['textMuted']}>{marker}</Text>
        <Text color={theme['text']}>{plugin.name}</Text>
        <Text color={theme['textMuted']}>{` v${plugin.version}`}</Text>
        {broken ? <Text color={theme['error']}>{'  ⚠ broken'}</Text> : null}
        <Box flexGrow={1} />
        <Text color={stateColor}>{stateGlyph}</Text>
      </Box>
      {selected ? <PluginDetail plugin={plugin} theme={theme} /> : null}
    </Box>
  );
}

function PluginDetail({
  plugin,
  theme,
}: {
  readonly plugin: PluginListItem;
  readonly theme: Record<string, string>;
}): React.JSX.Element {
  const flags = plugin.capabilityFlags ?? [];
  const perms = plugin.permissions ?? [];
  return (
    <Box flexDirection="column" width="100%">
      {plugin.description !== undefined && plugin.description.length > 0 ? (
        <Text color={theme['textMuted']}>{`    ${plugin.description}`}</Text>
      ) : null}
      <Text color={theme['textMuted']}>{`    source: ${plugin.source}`}</Text>
      {plugin.manifestError !== undefined ? (
        <Text color={theme['error']}>{`    manifest error: ${plugin.manifestError}`}</Text>
      ) : null}
      {flags.length > 0 ? (
        <Box flexDirection="row" width="100%">
          <Text color={theme['textMuted']}>{'    flags: '}</Text>
          {flags.map((f, i) => (
            <Text
              key={f}
              color={DANGEROUS_FLAGS.has(f) ? theme['warning'] : theme['textMuted']}
            >
              {i === 0 ? f : `, ${f}`}
            </Text>
          ))}
        </Box>
      ) : null}
      {perms.length > 0 ? (
        <Text color={theme['textMuted']}>{`    permissions: ${perms.join(', ')}`}</Text>
      ) : null}
    </Box>
  );
}

function sliceVisible(
  rows: readonly Row[],
  selectedIdx: number,
): { readonly start: number; readonly rows: readonly Row[] } {
  if (rows.length <= VISIBLE_ROWS) return { start: 0, rows };
  let start = Math.max(0, selectedIdx - Math.floor(VISIBLE_ROWS / 2));
  const end = Math.min(rows.length, start + VISIBLE_ROWS);
  start = Math.max(0, end - VISIBLE_ROWS);
  return { start, rows: rows.slice(start, end) };
}
