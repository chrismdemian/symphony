import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { configFilePath, defaultConfig, saveConfig } from '../utils/config.js';

/**
 * Phase 3H.1 — `symphony config --edit` command.
 *
 * Spawns `$EDITOR` (or platform fallback) against `~/.symphony/config.json`,
 * inheriting stdio so the editor takes over the user's terminal. Creates
 * the file with default content (mode 0o600) if it doesn't exist so the
 * user always sees the schema, never an empty file.
 *
 * Editor resolution cascade:
 *   1. `$VISUAL` (POSIX convention — for full-screen editors)
 *   2. `$EDITOR`
 *   3. `notepad` on Win32, `vi` everywhere else
 *
 * Returns the editor's exit code. The CLI subcommand exits the process
 * with that code so shell scripts can chain on success.
 *
 * Why this lives in `src/cli/`: it's a one-shot helper, not part of the
 * orchestrator runtime. Importing the orchestrator + Maestro stack just
 * to spawn an editor would be wrong shape — `symphony config --edit`
 * should be a fast process that doesn't even boot Symphony.
 */

export interface RunConfigEditInput {
  /** Override the file path (tests). Defaults to `configFilePath()`. */
  readonly configFilePath?: string;
  /** Override the editor command (tests). Defaults to the env-cascade. */
  readonly editor?: string;
  /** Override `child_process.spawn` (tests). */
  readonly spawnFn?: typeof spawn;
  /** Override the env (tests). */
  readonly env?: NodeJS.ProcessEnv;
  /** Override platform detection (tests). */
  readonly platform?: NodeJS.Platform;
}

export interface RunConfigEditResult {
  /** Editor's exit code. 0 on success. */
  readonly exitCode: number;
  /** Resolved file path (after env override + abs-path resolve). */
  readonly filePath: string;
  /** Resolved editor command. */
  readonly editor: string;
  /** True iff the file did not exist before this call (we created it). */
  readonly created: boolean;
}

export async function runConfigEdit(input: RunConfigEditInput = {}): Promise<RunConfigEditResult> {
  const filePath = input.configFilePath !== undefined
    ? path.resolve(input.configFilePath)
    : configFilePath();
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const editor = input.editor ?? resolveEditor(env, platform);
  const spawnFn = input.spawnFn ?? spawn;

  let created = false;
  try {
    await fsp.access(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      await saveConfig(defaultConfig(), filePath);
      created = true;
    } else {
      throw cause;
    }
  }

  // Spawn the editor inheriting stdio so the user's terminal is its
  // canvas. `shell: true` is required because `$EDITOR` may be a
  // multi-word command (`code --wait`, `vim -p`) that needs shell
  // tokenization, and on Win32 `notepad`/`code` resolve through
  // PATHEXT.
  //
  // **Critical (Win32 audit M1)**: with `shell: true`, the args array
  // is concatenated unquoted onto the command string, so a path
  // containing spaces (`C:\Users\Some User\.symphony\config.json`)
  // splits into multiple positional args at the shell level. Node
  // also emits DEP0190 for this pattern. Fix: pass the entire
  // command-line as a single shell-escaped string and an empty argv,
  // doing the quoting ourselves. POSIX uses single-quotes (with
  // single-quote escape rules); Win32 uses double-quotes. The path
  // is the only untrusted-shape data; the editor is from env and is
  // already shell-tokenized at the user's discretion.
  const command = buildEditorCommand(editor, filePath, platform);
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawnFn(command, [], {
      stdio: 'inherit',
      shell: true,
      env,
    });
    child.once('error', (err) => reject(err));
    child.once('exit', (code) => resolve(code ?? 0));
  });

  return { exitCode, filePath, editor, created };
}

/**
 * Compose `<editor> <quoted-path>` for shell execution. The editor
 * portion is forwarded as the user wrote it (so multi-word `$EDITOR`
 * keeps working). The path is shell-quoted using platform-appropriate
 * rules so spaces and metacharacters don't split into multiple args.
 *
 * Win32 `cmd.exe` honors double-quotes around path args. Embedded
 * double-quotes in a Win32 path are illegal at the filesystem level —
 * but we still escape `"` defensively.
 *
 * POSIX shells respect single-quotes literally — no escapes inside —
 * EXCEPT a single-quote itself, which we close-escape-reopen
 * (`'\''`). This is the documented POSIX-portable shell-quote pattern.
 */
function buildEditorCommand(
  editor: string,
  filePath: string,
  platform: NodeJS.Platform,
): string {
  if (platform === 'win32') {
    const escaped = filePath.replace(/"/g, '\\"');
    return `${editor} "${escaped}"`;
  }
  const escaped = filePath.replace(/'/g, `'\\''`);
  return `${editor} '${escaped}'`;
}

function resolveEditor(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const visual = env['VISUAL']?.trim();
  if (visual !== undefined && visual.length > 0) return visual;
  const editor = env['EDITOR']?.trim();
  if (editor !== undefined && editor.length > 0) return editor;
  return platform === 'win32' ? 'notepad' : 'vi';
}
