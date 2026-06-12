import { describe, it, expect, vi } from 'vitest';
import { renameWithRetry } from '../../src/utils/atomic.js';

/**
 * `renameWithRetry` — Windows rename-contention resilience.
 *
 * The retry path is Windows-only by design (POSIX rename is atomic and a
 * real EACCES must surface immediately). Tests drive the platform via the
 * `_platform` seam so they run identically on every CI OS, and inject a
 * fake rename + no-op sleep so there's no real FS contention or wall-clock
 * cost.
 */

function erron(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('renameWithRetry', () => {
  it('succeeds on the first attempt without retrying', async () => {
    const rename = vi.fn(async () => undefined);
    await renameWithRetry('a.tmp', 'a', { _rename: rename, _sleep: noSleep, _platform: 'win32' });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith('a.tmp', 'a');
  });

  it('retries a transient EPERM on win32 then succeeds', async () => {
    let calls = 0;
    const rename = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw erron('EPERM');
    });
    await renameWithRetry('a.tmp', 'a', { _rename: rename, _sleep: noSleep, _platform: 'win32' });
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries %s on win32', async (code) => {
    let calls = 0;
    const rename = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw erron(code);
    });
    await renameWithRetry('a.tmp', 'a', { _rename: rename, _sleep: noSleep, _platform: 'win32' });
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on non-win32 — surfaces the error immediately', async () => {
    const rename = vi.fn(async () => {
      throw erron('EPERM');
    });
    await expect(
      renameWithRetry('a.tmp', 'a', { _rename: rename, _sleep: noSleep, _platform: 'linux' }),
    ).rejects.toThrow(/EPERM/);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-transient code (ENOENT) even on win32', async () => {
    const rename = vi.fn(async () => {
      throw erron('ENOENT');
    });
    await expect(
      renameWithRetry('a.tmp', 'a', { _rename: rename, _sleep: noSleep, _platform: 'win32' }),
    ).rejects.toThrow(/ENOENT/);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('rethrows the last error after exhausting the retry budget (6 attempts)', async () => {
    const rename = vi.fn(async () => {
      throw erron('EBUSY');
    });
    await expect(
      renameWithRetry('a.tmp', 'a', { _rename: rename, _sleep: noSleep, _platform: 'win32' }),
    ).rejects.toThrow(/EBUSY/);
    // initial attempt + 5 backoff retries = 6 total
    expect(rename).toHaveBeenCalledTimes(6);
  });
});
