/**
 * Phase 3H.3 — Cross-platform desktop notification shim.
 *
 * Three platforms, three native tools, one signature:
 *   - Win32: `powershell.exe` with the toast XML piped through stdin
 *     (avoids cmd.exe escape minefields). Without an AUMID-registered
 *     Start-menu shortcut, Win11 may show "PowerShell" as the source —
 *     acceptable for v1; AUMID registration is a future polish item.
 *   - Darwin: `osascript -e 'display notification "..." with title "..."'`
 *   - Linux: `notify-send <title> <body>`. ENOENT (no notify-send on
 *     PATH) swallowed silently. Distros without libnotify get no
 *     toasts; not a failure mode worth aborting the orchestrator over.
 *
 * Errors are NEVER thrown from this module. The lifecycle hooks fire
 * `void spawnToast(...).catch(() => {})` and any spawn failure must
 * not poison subsequent calls or affect the worker fan-out.
 *
 * Title and body are passed pre-truncated by the dispatcher (120 char
 * body cap per spec, title is short by construction). Per-platform
 * escaping happens here — XML for PowerShell, AppleScript-string for
 * osascript, and pure argv pass-through for notify-send.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { SpawnImpl, SpawnHandle, ToastInput, Platform } from './types.js';

const DEFAULT_TIMEOUT_MS = 5000;

const realSpawn: SpawnImpl = (cmd, args, opts) => {
  const child = nodeSpawn(cmd, [...args], {
    stdio: opts.stdio !== undefined ? [...opts.stdio] : ['pipe', 'ignore', 'ignore'],
    windowsHide: opts.windowsHide ?? true,
  });
  return adaptChildProcess(child);
};

function adaptChildProcess(child: ChildProcess): SpawnHandle {
  const handle: SpawnHandle = {
    stdin: {
      write(data: string): void {
        // `child.stdin` may be null if the caller passed `stdio: 'ignore'`
        // for stdin. The Win32 path always uses 'pipe' for stdin so this
        // is safe — but guard defensively.
        child.stdin?.write(data);
      },
      end(): void {
        child.stdin?.end();
      },
    },
    on(event, listener): SpawnHandle {
      child.on(event, listener);
      return handle;
    },
    kill(signal): boolean {
      return child.kill(signal);
    },
  };
  return handle;
}

/**
 * XML-escape a string for embedding inside a PowerShell single-quoted
 * `LoadXml('...')` literal. Order matters: ampersands first, otherwise
 * we'd double-encode. The full XML 1.0 character set is the union of
 * `& < > " '`. Output is safe both for XML parsing and for a single-
 * quoted PowerShell string (since the escaping converts `'` to
 * `&apos;`, no PS-level quote escaping is required).
 */
export function xmlEscape(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * AppleScript-string escape: `"` → `\"`, `\` → `\\`. Order matters —
 * escape the backslash FIRST, otherwise the new backslashes from the
 * quote-replacement would themselves get escaped.
 */
export function appleScriptEscape(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build the PowerShell script that displays a Windows toast via the
 * WinRT API. Returned as a single string ready to be piped to
 * `powershell.exe -Command -`. The XML structure is the minimum
 * `ToastGeneric` template per Microsoft's docs.
 */
export function buildPowerShellScript(title: string, body: string): string {
  const safeTitle = xmlEscape(title);
  const safeBody = xmlEscape(body);
  return [
    `$ErrorActionPreference = 'Stop'`,
    `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null`,
    `[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] | Out-Null`,
    `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
    `$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${safeTitle}</text><text>${safeBody}</text></binding></visual></toast>')`,
    `$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Symphony').Show($toast)`,
  ].join('\n');
}

/**
 * Cross-platform desktop toast. Returns a Promise that resolves on
 * spawn-completion or timeout. NEVER rejects — callers `.catch(() => {})`
 * for ergonomics, but the implementation is also defensive.
 */
export function spawnToast(input: ToastInput): Promise<void> {
  const platform: Platform = input.platform ?? (process.platform as Platform);
  const spawnImpl: SpawnImpl = input.spawnImpl ?? realSpawn;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    let child: SpawnHandle | undefined;
    try {
      if (platform === 'win32') {
        child = spawnImpl(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', '-'],
          { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
        );
        child.stdin.write(buildPowerShellScript(input.title, input.body));
        child.stdin.end();
      } else if (platform === 'darwin') {
        const escTitle = appleScriptEscape(input.title);
        const escBody = appleScriptEscape(input.body);
        child = spawnImpl(
          'osascript',
          ['-e', `display notification "${escBody}" with title "${escTitle}"`],
          { stdio: ['ignore', 'ignore', 'ignore'] },
        );
      } else if (platform === 'linux') {
        child = spawnImpl('notify-send', [input.title, input.body], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
      } else {
        // Unknown platform — silently no-op. Symphony today targets the
        // big three; BSDs / Termux / etc. would need their own branch.
        settle();
        return;
      }
    } catch {
      // Synchronous spawn errors (e.g., EACCES) — swallow.
      settle();
      return;
    }

    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        // best effort
      }
      settle();
    }, timeoutMs);
    timer.unref?.();

    child.on('error', () => {
      // ENOENT (notify-send not installed, etc.) — swallow.
      clearTimeout(timer);
      settle();
    });
    child.on('exit', () => {
      clearTimeout(timer);
      settle();
    });
  });
}
