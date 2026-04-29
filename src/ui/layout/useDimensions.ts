import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/**
 * Reactive terminal dimensions hook.
 *
 * Reads dimensions from Ink's INJECTED stdout (`useStdout()`), not the
 * global `process.stdout` — required for tests that override stdout
 * (`runTui({ stdout: fakeStream })`) and for any future remote-render
 * shape where Ink runs against a non-process stream (audit C3).
 *
 * Initial read is synchronous inside `useState(() => …)` so the first
 * paint reflects real dimensions (no 80×24 → resize flicker). Subscribes
 * to `'resize'` for live updates.
 *
 * Gotchas:
 * - On non-TTY stdout (CI, piped output) `'resize'` never fires. The
 *   guard skips the subscription; the snapshot returns the fallback.
 *   `runTui` already prevents this branch from running in production
 *   via its TTY guard, but the hook's own check defends against tests.
 * - Windows ConPTY: `columns` can briefly be `undefined` very early in
 *   process boot. Coalesce `?? 80` / `?? 24`.
 * - SIGWINCH abstraction: Node emits `'resize'` on the stdout TTY on
 *   both POSIX and Win32 (libuv shim). No platform branch needed.
 */
export interface Dimensions {
  readonly columns: number;
  readonly rows: number;
}

const FALLBACK: Dimensions = { columns: 80, rows: 24 };

function readSnapshot(stdout: NodeJS.WriteStream): Dimensions {
  const cols = stdout.columns;
  const rows = stdout.rows;
  return {
    columns: typeof cols === 'number' && cols > 0 ? cols : FALLBACK.columns,
    rows: typeof rows === 'number' && rows > 0 ? rows : FALLBACK.rows,
  };
}

export function useStdoutDimensions(): Dimensions {
  const { stdout } = useStdout();
  const out = stdout as NodeJS.WriteStream;
  const [dims, setDims] = useState<Dimensions>(() => readSnapshot(out));

  useEffect(() => {
    if (out.isTTY !== true) return undefined;
    const onResize = (): void => setDims(readSnapshot(out));
    out.on('resize', onResize);
    return () => {
      out.off('resize', onResize);
    };
  }, [out]);

  return dims;
}
