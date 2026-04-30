import React from 'react';
import { render } from 'ink';
import { App } from '../App.js';
import type { MaestroController } from '../data/MaestroEventsProvider.js';
import type { TuiRpc } from './rpc.js';

/**
 * `runTui` — entry point. Replaces the readline loop in `cli/start.ts`.
 *
 * Behavior:
 * - Renders `<App>` with `alternateScreen: true` + `concurrent: true`
 *   (Ink 7 native; no `fullscreen-ink` dep).
 * - Returns `{unmount, exited}` so the launcher can push `unmount` onto
 *   its existing LIFO cleanup stack and `await exited` to know when
 *   `app.unmount()` finishes flushing.
 * - On non-TTY stdout (CI, piped output), DOES NOT render Ink — Ink's
 *   alt-screen would write garbage to a pipe. Returns a no-op handle so
 *   `cli/start.ts` falls back to its existing readline loop seamlessly.
 *
 * The launcher continues to own SIGINT, the 5 s shutdown deadline, and
 * the `taskkill /T /F` Win32 path (audit 2C.2 m7). `runTui` only owns
 * the Ink lifecycle.
 */

export interface RunTuiInput {
  readonly maestro: MaestroController;
  readonly rpc: TuiRpc;
  readonly version: string;
  /** Called when the user presses Ctrl+C. Launcher's `stop()` is the natural target. */
  readonly onRequestExit: () => void;
  /** Override stdin/stdout (tests). Defaults to `process.stdin`/`process.stdout`. */
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
}

export interface RunTuiHandle {
  /** Whether Ink rendering actually started. False on non-TTY. */
  readonly active: boolean;
  /** Unmount the Ink app. Idempotent. Resolves once stdout is restored. */
  unmount(): Promise<void>;
  /** Settles when the Ink app exits (manual unmount or Ink-internal exit). */
  readonly exited: Promise<void>;
}

export const NOOP_TUI_HANDLE: RunTuiHandle = {
  active: false,
  unmount: async () => {
    // nothing to unmount
  },
  exited: Promise.resolve(),
};

export function runTui(input: RunTuiInput): RunTuiHandle {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;

  // TTY guard — BOTH streams must be TTYs.
  // - stdout non-TTY: Ink's alt-screen would emit ANSI into a pipe.
  // - stdin non-TTY: Ink's `useInput` calls `setRawMode` which throws on
  //   piped stdin ("Raw mode is not supported on the stdin provided to
  //   Ink"). Crash kills the App tree mid-render and leaves Maestro
  //   running in the background. Audit C1 — confirmed via
  //   `echo hi | symphony start`. The launcher's readline loop is the
  //   right fallback.
  if (stdout.isTTY !== true || stdin.isTTY !== true) {
    return NOOP_TUI_HANDLE;
  }

  const instance = render(
    React.createElement(App, {
      maestro: input.maestro,
      rpc: input.rpc,
      version: input.version,
      onRequestExit: input.onRequestExit,
    }),
    {
      stdout,
      stdin,
      // Ink 7 native alt-screen — equivalent to `fullscreen-ink`'s
      // `withFullScreen()`. Restores the prior screen content on unmount.
      // DEC mode 2026 sync output is auto-applied by Ink 6.7+.
      exitOnCtrlC: false,
      // `patchConsole: false` — Ink's default `patchConsole` intercepts
      // `console.log` calls and re-routes them above the live render.
      // Symphony's launcher logs go to stderr (audit 2C.2), so the patch
      // adds noise to the TUI for no benefit. Also: `patch-console@2`
      // calls `new console.Console()` which throws under vitest's
      // sandboxed runtime, breaking unit tests of `runTui`.
      patchConsole: false,
    },
  );

  // `exitOnCtrlC: false` because Ctrl+C is wired through our
  // `onRequestExit` → launcher's `stop()` so the full LIFO cleanup chain
  // runs (audit 2C.2). Without this flag Ink would `process.exit(0)`
  // and skip the cleanup stack.

  let unmounted = false;
  const handle: RunTuiHandle = {
    active: true,
    async unmount(): Promise<void> {
      if (unmounted) return;
      unmounted = true;
      instance.unmount();
      await instance.waitUntilExit().catch(() => {});
    },
    exited: instance.waitUntilExit().then(
      () => undefined,
      () => undefined,
    ),
  };
  return handle;
}
