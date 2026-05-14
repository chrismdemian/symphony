import React from 'react';
import { render } from 'ink';
import { App } from '../App.js';
import type { MaestroController } from '../data/MaestroEventsProvider.js';
import type { TuiRpc } from './rpc.js';

/**
 * Kitty-keyboard pop sequence — sent on process exit as a belt-and-
 * suspenders safety net. Ink's unmount path emits this for us, but the
 * launcher's 5 s SIGKILL deadline (audit 2C.2) can skip Ink unmount
 * entirely. Without the manual pop, the parent shell inherits a stuck
 * kitty mode and types as garbled escapes until the user manually
 * resets the terminal.
 */
const KITTY_POP = '\x1b[<u';

/**
 * Tracks stdout streams that already have an `'exit'` listener attached
 * so re-entry from tests (or hot-reload-style multiple `runTui` calls)
 * doesn't accumulate listeners. Identity-keyed; multiple `runTui` for
 * the same stdout register exactly one listener.
 */
const exitListenerRegistered = new WeakSet<NodeJS.WriteStream>();

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
  /**
   * Phase 3H.1 — pre-open a popup on App mount. Used by `symphony config`
   * to land directly on the settings popup. Fires exactly once via a
   * mount-time effect in `<AppShell>`. Re-mount (e.g. tests) re-fires.
   */
  readonly initialPopup?: string;
  /**
   * Phase 3Q — boot-time recovery snapshot. When `crashedIds.length > 0`,
   * `<AppShell>` dispatches a one-shot SystemSummary chat row at mount
   * naming the recovered workers. The launcher reads the snapshot via
   * `rpc.call.recovery.report()` and threads it through. Fires exactly
   * once (StrictMode-safe firedRef).
   */
  readonly recovery?: {
    readonly crashedIds: readonly string[];
    readonly capturedAt: string;
  };
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

  // Belt-and-suspenders kitty pop: register ONCE per stdout. The
  // launcher's 5s SIGKILL deadline (audit 2C.2) can skip Ink unmount.
  // Without the manual pop, the parent shell stays in kitty mode and
  // typed keys arrive as escape garbage until the user manually resets.
  if (!exitListenerRegistered.has(stdout)) {
    exitListenerRegistered.add(stdout);
    process.on('exit', () => {
      try {
        if (stdout.isTTY === true && typeof stdout.write === 'function') {
          stdout.write(KITTY_POP);
        }
      } catch {
        // Best-effort — if stdout is already closed there's nothing to do.
      }
    });
  }

  const instance = render(
    React.createElement(App, {
      maestro: input.maestro,
      rpc: input.rpc,
      version: input.version,
      onRequestExit: input.onRequestExit,
      ...(input.initialPopup !== undefined ? { initialPopup: input.initialPopup } : {}),
      ...(input.recovery !== undefined ? { recovery: input.recovery } : {}),
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
      // Kitty keyboard protocol — auto-detect on supporting terminals
      // (Windows Terminal 1.21+, iTerm2 3.5.7+, Ghostty, kitty itself).
      // `reportAllKeysAsEscapeCodes` (flag 8) is the load-bearing flag:
      // without it, `key.return && key.shift` can't fire because Enter
      // arrives as plain `\r` even on supporting terminals. With flag 8,
      // every keystroke is wrapped in CSI-u so modifiers are explicit.
      // `Ctrl+J` remains the universal fallback for non-kitty terminals.
      kittyKeyboard: {
        mode: 'auto',
        flags: ['disambiguateEscapeCodes', 'reportEventTypes', 'reportAllKeysAsEscapeCodes'],
      },
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
