import React, { useCallback, useEffect } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigProvider, useConfig } from '../../src/utils/config-context.js';
import {
  SYMPHONY_CONFIG_FILE_ENV,
  _resetConfigWriteQueue,
} from '../../src/utils/config.js';
import { defaultConfig } from '../../src/utils/config-schema.js';

/**
 * Phase 3M commit 2 audit M1/M2 — rapid `<leader>a a` (or two `/away`
 * presses inside the same render frame) MUST toggle twice. The buggy
 * shape was a useCallback that closure-captured `config.awayMode` from
 * the render snapshot, so a synchronous double-fire computed the same
 * `next` value for both and flipped only once with the second press
 * being a no-op (or worse, RPC out-of-sync from disk).
 *
 * Fix: function-patch INSIDE `setConfig`'s serialization queue resolves
 * against the just-committed state, identical to the 3H.2 audit C2 fix
 * for `<leader>m`. This file pins the contract.
 */

interface MockAppProps {
  readonly handlerRef: { current?: () => Promise<void> };
  readonly toastSpy: (msg: string) => void;
}

function MockApp({ handlerRef, toastSpy }: MockAppProps): React.JSX.Element {
  const { setConfig } = useConfig();
  // Mirror App.tsx's `toggleAwayMode` post-fix shape.
  const toggle = useCallback(async () => {
    const next = await setConfig((current) => ({ awayMode: !current.awayMode }));
    toastSpy(`Away mode: ${next.awayMode ? 'on' : 'off'}.`);
  }, [setConfig, toastSpy]);
  useEffect(() => {
    handlerRef.current = toggle;
  }, [handlerRef, toggle]);
  return <></>;
}

describe('App `<leader>a` / `/away` handler — rapid-fire correctness (3M audit M1/M2)', () => {
  let tmp: string;
  let cfgFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    _resetConfigWriteQueue();
    tmp = mkdtempSync(join(tmpdir(), 'symphony-away-handler-'));
    cfgFile = join(tmp, 'config.json');
    prevEnv = process.env[SYMPHONY_CONFIG_FILE_ENV];
    process.env[SYMPHONY_CONFIG_FILE_ENV] = cfgFile;
  });

  afterEach(() => {
    _resetConfigWriteQueue();
    if (prevEnv === undefined) delete process.env[SYMPHONY_CONFIG_FILE_ENV];
    else process.env[SYMPHONY_CONFIG_FILE_ENV] = prevEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('two synchronous fires toggle to on then back to off', async () => {
    const handlerRef: { current?: () => Promise<void> } = {};
    const toastSpy = vi.fn();
    const initial = { config: defaultConfig(), source: { kind: 'default' as const } };
    render(
      <ConfigProvider initial={initial}>
        <MockApp handlerRef={handlerRef} toastSpy={toastSpy} />
      </ConfigProvider>,
    );
    await new Promise((r) => setTimeout(r, 30));
    if (handlerRef.current === undefined) throw new Error('handler not captured');

    const first = handlerRef.current();
    const second = handlerRef.current();
    await Promise.all([first, second]);

    // Default awayMode=false. First fire flips to on; second fire
    // re-reads from the function-patch's `current` (just-committed
    // 'on') and flips back to off. Toasts reflect the resolved values,
    // NOT a closure-captured stale snapshot.
    expect(toastSpy).toHaveBeenCalledTimes(2);
    expect(toastSpy.mock.calls[0]?.[0]).toContain('Away mode: on');
    expect(toastSpy.mock.calls[1]?.[0]).toContain('Away mode: off');
  });

  it('three synchronous fires alternate on → off → on', async () => {
    const handlerRef: { current?: () => Promise<void> } = {};
    const toastSpy = vi.fn();
    const initial = { config: defaultConfig(), source: { kind: 'default' as const } };
    render(
      <ConfigProvider initial={initial}>
        <MockApp handlerRef={handlerRef} toastSpy={toastSpy} />
      </ConfigProvider>,
    );
    await new Promise((r) => setTimeout(r, 30));
    if (handlerRef.current === undefined) throw new Error('handler not captured');

    await Promise.all([
      handlerRef.current(),
      handlerRef.current(),
      handlerRef.current(),
    ]);

    expect(toastSpy).toHaveBeenCalledTimes(3);
    const messages = toastSpy.mock.calls.map((c) => c[0] as string);
    expect(messages[0]).toContain('Away mode: on');
    expect(messages[1]).toContain('Away mode: off');
    expect(messages[2]).toContain('Away mode: on');
  });
});
