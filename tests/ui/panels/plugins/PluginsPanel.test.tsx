import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render as inkRender } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../../../src/ui/keybinds/dispatcher.js';
import { ConfigProvider } from '../../../../src/utils/config-context.js';
import { ToastProvider } from '../../../../src/ui/feedback/ToastProvider.js';
import { ToastTray } from '../../../../src/ui/feedback/ToastTray.js';
import { PluginsPanel } from '../../../../src/ui/panels/plugins/PluginsPanel.js';
import { defaultConfig, type SymphonyConfig } from '../../../../src/utils/config-schema.js';
import type { ConfigSource } from '../../../../src/utils/config.js';
import type { PluginListItem } from '../../../../src/rpc/router-impl.js';
import type { TuiRpc } from '../../../../src/ui/runtime/rpc.js';

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');

function item(over: Partial<PluginListItem> = {}): PluginListItem {
  return {
    id: over.id ?? 'echo',
    name: over.name ?? 'Echo',
    version: over.version ?? '1.0.0',
    enabled: over.enabled ?? false,
    source: over.source ?? '/src/echo',
    installedAt: over.installedAt ?? '2026-06-03T00:00:00.000Z',
    ...over,
  };
}

interface FakeRpcHandle {
  rpc: TuiRpc;
  calls: {
    setEnabled: Array<{ id: string; enabled: boolean }>;
    install: Array<{ source: string }>;
    remove: Array<{ id: string }>;
  };
}

/** Stateful fake — mutations update the in-memory list so the panel's
 *  post-mutation `refresh()` reflects the change. */
function makeFakeRpc(initial: PluginListItem[]): FakeRpcHandle {
  let list = initial.map((p) => ({ ...p }));
  const calls = {
    setEnabled: [] as Array<{ id: string; enabled: boolean }>,
    install: [] as Array<{ source: string }>,
    remove: [] as Array<{ id: string }>,
  };
  const rpc = {
    call: {
      plugins: {
        list: vi.fn(() => Promise.resolve(list.map((p) => ({ ...p })))),
        setEnabled: vi.fn(({ id, enabled }: { id: string; enabled: boolean }) => {
          calls.setEnabled.push({ id, enabled });
          list = list.map((p) => (p.id === id ? { ...p, enabled } : p));
          return Promise.resolve({ id, enabled });
        }),
        install: vi.fn(({ source }: { source: string }) => {
          calls.install.push({ source });
          list = [...list, item({ id: 'newp', name: 'NewP', version: '2.0.0', source })];
          return Promise.resolve({ id: 'newp', name: 'NewP', version: '2.0.0', reinstall: false });
        }),
        remove: vi.fn(({ id }: { id: string }) => {
          calls.remove.push({ id });
          list = list.filter((p) => p.id !== id);
          return Promise.resolve({ id, removedRow: true, removedDir: true });
        }),
      },
    },
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as TuiRpc;
  return { rpc, calls };
}

interface HarnessProps {
  readonly rpc: TuiRpc;
  readonly config?: SymphonyConfig;
}

function Harness({ rpc, config }: HarnessProps): React.JSX.Element {
  const initial: FocusState = {
    stack: [
      { kind: 'main', key: 'chat' },
      { kind: 'popup', key: 'plugins' },
    ],
  };
  const initialConfig = config ?? defaultConfig();
  const initialSource: ConfigSource = { kind: 'default' };
  return (
    <ThemeProvider>
      <ToastProvider>
        <ConfigProvider initial={{ config: initialConfig, source: initialSource }}>
          <FocusProvider initial={initial}>
            <KeybindProvider initialCommands={[]}>
              <PluginsPanel rpc={rpc} />
              <ToastTray />
            </KeybindProvider>
          </FocusProvider>
        </ConfigProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

const settle = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

const liveRenders: Array<{ readonly unmount: () => void }> = [];
const render = (el: React.JSX.Element): ReturnType<typeof inkRender> => {
  const r = inkRender(el);
  liveRenders.push(r);
  return r;
};
afterEach(() => {
  for (const r of liveRenders.splice(0)) r.unmount();
});

/*
 * RENDER-ONLY assertions. Keystroke-driven interactions (toggle / install /
 * remove via Space/Enter/x) are flaky under the full parallel unit run
 * (ink-testing-library keystroke delivery races React commits — the
 * documented 3E/3J gotcha) and are covered end-to-end in
 * `tests/scenarios/7c.test.ts` against the launcher's real PassThrough
 * stdin. Here we only assert what a single mount renders.
 */
describe('<PluginsPanel> (7C)', () => {
  it('renders the header, master switch, and plugin rows', async () => {
    const fake = makeFakeRpc([item({ id: 'echo', enabled: true }), item({ id: 'notifier', name: 'Notifier' })]);
    const { lastFrame } = render(<Harness rpc={fake.rpc} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Plugins');
    expect(frame).toContain('master switch');
    expect(frame).toContain('Echo');
    expect(frame).toContain('Notifier');
    expect(frame).toContain('✓ enabled');
    expect(frame).toContain('○ disabled');
  });

  it('renders the empty state when no plugins are installed', async () => {
    const fake = makeFakeRpc([]);
    const { lastFrame } = render(<Harness rpc={fake.rpc} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('No plugins installed');
  });

  it('shows the master switch as ON from config', async () => {
    const fake = makeFakeRpc([]);
    const cfg: SymphonyConfig = { ...defaultConfig(), pluginsEnabled: true };
    const { lastFrame } = render(<Harness rpc={fake.rpc} config={cfg} />);
    await settle();
    expect(stripAnsi(lastFrame() ?? '')).toMatch(/master switch[\s\S]*on/);
  });

  it('shows the master switch as OFF from config', async () => {
    const fake = makeFakeRpc([]);
    const { lastFrame } = render(<Harness rpc={fake.rpc} />); // default pluginsEnabled=false
    await settle();
    expect(stripAnsi(lastFrame() ?? '')).toMatch(/master switch[\s\S]*off/);
  });

  it('renders both enabled and disabled glyphs for a mixed list', async () => {
    const fake = makeFakeRpc([
      item({ id: 'a', name: 'Aaa', enabled: true }),
      item({ id: 'b', name: 'Bbb', enabled: false }),
    ]);
    const { lastFrame } = render(<Harness rpc={fake.rpc} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('✓ enabled');
    expect(frame).toContain('○ disabled');
  });

  it('flags an orphaned (manifestError) plugin as broken', async () => {
    const fake = makeFakeRpc([
      item({ id: 'orphan', name: 'orphan', manifestError: 'no plugin.json on disk' }),
    ]);
    const { lastFrame } = render(<Harness rpc={fake.rpc} />);
    await settle();
    expect(stripAnsi(lastFrame() ?? '')).toContain('⚠ broken');
  });

  it('footer hint advertises the key bindings', async () => {
    const fake = makeFakeRpc([]);
    const { lastFrame } = render(<Harness rpc={fake.rpc} />);
    await settle();
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toMatch(/navigate/);
    expect(frame).toMatch(/install/);
    expect(frame).toMatch(/remove/);
    expect(frame).toMatch(/Esc/);
  });
});
