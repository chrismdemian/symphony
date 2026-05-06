import React, { useCallback, useEffect } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigProvider,
  useConfig,
} from '../../src/utils/config-context.js';
import {
  SYMPHONY_CONFIG_FILE_ENV,
  _resetConfigWriteQueue,
} from '../../src/utils/config.js';
import { defaultConfig } from '../../src/utils/config-schema.js';

/**
 * Phase 3H.2 commit 5 audit C2 — rapid `<leader>m m` MUST toggle twice.
 * The bug: a useCallback that captures `config.modelMode` from render
 * reads the stale value on a synchronous double-fire because
 * `setConfig`'s commit hasn't re-rendered yet.
 *
 * Fix: ref-mirror `config` and read from the ref inside the callback
 * — mirrors the dispatcher's `leaderActiveRef` pattern (3F.2 audit C1).
 *
 * This harness mounts ConfigProvider + a MockApp that exposes the
 * cycleModelMode handler via ref. The test fires it twice synchronously
 * and asserts the disk persisted the second toggle (back to 'mixed').
 */

interface MockAppProps {
  readonly handlerRef: { current?: () => Promise<void> };
  readonly toastSpy: (msg: string) => void;
}

function MockApp({ handlerRef, toastSpy }: MockAppProps): React.JSX.Element {
  const { setConfig } = useConfig();
  // Mirror App.tsx's post-fix handler: function-patch resolves
  // against the just-committed state INSIDE setConfig's queue.
  const cycle = useCallback(async () => {
    const next = await setConfig((current) => ({
      modelMode: current.modelMode === 'opus' ? 'mixed' : 'opus',
    }));
    toastSpy(`Model mode: ${next.modelMode} (applies on next start).`);
  }, [setConfig, toastSpy]);
  useEffect(() => {
    handlerRef.current = cycle;
  }, [handlerRef, cycle]);
  return <></>;
}

describe('App `<leader>m` handler — rapid-fire correctness (3H.2 audit C2)', () => {
  let tmp: string;
  let cfgFile: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    _resetConfigWriteQueue();
    tmp = mkdtempSync(join(tmpdir(), 'symphony-leader-handler-'));
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

  it('two synchronous fires toggle to opus then back to mixed', async () => {
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

    // First fire reads 'mixed' (initial), flips to 'opus'.
    // Second fire reads 'opus' from the ref-mirror (which the
    // applyPatchToDisk queue ensures has settled), flips to 'mixed'.
    expect(toastSpy).toHaveBeenCalledTimes(2);
    expect(toastSpy.mock.calls[0]?.[0]).toContain('opus');
    expect(toastSpy.mock.calls[1]?.[0]).toContain('mixed');
  });

  it('three synchronous fires alternate opus → mixed → opus', async () => {
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
    expect(messages[0]).toContain('opus');
    expect(messages[1]).toContain('mixed');
    expect(messages[2]).toContain('opus');
  });
});
