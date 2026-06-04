import React, { useEffect } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as inkRender } from 'ink-testing-library';
import { Text } from 'ink';
import { usePlugins } from '../../../src/ui/data/usePlugins.js';
import type { PluginListItem } from '../../../src/rpc/router-impl.js';
import type { TuiRpc } from '../../../src/ui/runtime/rpc.js';

/**
 * Phase 7C — `usePlugins` fetches the installed-plugin list once at mount
 * (no background poll by default), exposes loading/error, and re-fetches
 * on `refresh()`.
 */

interface Deferred {
  resolve: (v: readonly PluginListItem[]) => void;
  reject: (e: unknown) => void;
}

function makeFakeRpc(): { rpc: TuiRpc; resolveNext: (l: readonly PluginListItem[]) => void; rejectNext: (e: unknown) => void; callCount: () => number } {
  const pending: Deferred[] = [];
  let calls = 0;
  const list = vi.fn().mockImplementation((): Promise<readonly PluginListItem[]> => {
    calls += 1;
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  });
  const rpc = {
    call: { plugins: { list, setEnabled: vi.fn(), install: vi.fn(), remove: vi.fn() } },
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as TuiRpc;
  return {
    rpc,
    resolveNext(v): void {
      const n = pending.shift();
      if (!n) throw new Error('no pending plugins.list call');
      n.resolve(v);
    },
    rejectNext(e): void {
      const n = pending.shift();
      if (!n) throw new Error('no pending plugins.list call');
      n.reject(e);
    },
    callCount: () => calls,
  };
}

function item(over: Partial<PluginListItem> = {}): PluginListItem {
  return {
    id: over.id ?? 'echo',
    name: over.name ?? 'Echo',
    version: over.version ?? '1.0.0',
    enabled: over.enabled ?? false,
    source: over.source ?? '/src',
    installedAt: over.installedAt ?? '2026-06-03T00:00:00.000Z',
    ...over,
  };
}

function Probe({ rpc, onState }: { rpc: TuiRpc; onState: (s: ReturnType<typeof usePlugins>) => void }): React.JSX.Element {
  const state = usePlugins(rpc);
  useEffect(() => {
    onState(state);
  });
  return <Text>{`n=${state.plugins.length} loading=${String(state.loading)} err=${state.error ? '1' : '0'}`}</Text>;
}

const settle = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Poll a condition up to `ms` — robust against React effect-scheduling
// latency under the full parallel suite (a fixed settle flakes under CPU
// pressure).
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

// Unmount prior renders so leftover Probe trees don't hold React's
// scheduler and starve later tests' updates (3H.4 gotcha).
const liveRenders: Array<{ readonly unmount: () => void }> = [];
const render = (el: React.JSX.Element): ReturnType<typeof inkRender> => {
  const r = inkRender(el);
  liveRenders.push(r);
  return r;
};
afterEach(() => {
  for (const r of liveRenders.splice(0)) r.unmount();
});

describe('usePlugins (7C)', () => {
  it('fetches once at mount and surfaces the list', async () => {
    const fake = makeFakeRpc();
    let last: ReturnType<typeof usePlugins> | null = null;
    const { lastFrame } = render(<Probe rpc={fake.rpc} onState={(s) => (last = s)} />);
    expect(fake.callCount()).toBe(1);
    fake.resolveNext([item({ id: 'a' }), item({ id: 'b' })]);
    await settle();
    expect(lastFrame()).toContain('n=2');
    expect(lastFrame()).toContain('loading=false');
    expect(last).not.toBeNull();
  });

  it('does NOT poll in the background by default', async () => {
    const fake = makeFakeRpc();
    render(<Probe rpc={fake.rpc} onState={() => undefined} />);
    fake.resolveNext([]);
    await settle(120);
    expect(fake.callCount()).toBe(1);
  });

  it('refresh() triggers another fetch', async () => {
    const fake = makeFakeRpc();
    let refreshFn: () => void = () => undefined;
    render(<Probe rpc={fake.rpc} onState={(s) => (refreshFn = s.refresh)} />);
    await waitFor(() => fake.callCount() === 1);
    fake.resolveNext([item({ id: 'a' })]);
    await settle();
    refreshFn();
    await waitFor(() => fake.callCount() === 2);
    expect(fake.callCount()).toBe(2);
    fake.resolveNext([item({ id: 'a' }), item({ id: 'c' })]);
    await settle();
  });

  it('surfaces an RPC error without crashing', async () => {
    const fake = makeFakeRpc();
    const { lastFrame } = render(<Probe rpc={fake.rpc} onState={() => undefined} />);
    fake.rejectNext(new Error('boom'));
    await settle();
    expect(lastFrame()).toContain('err=1');
  });
});
