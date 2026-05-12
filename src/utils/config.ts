import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { applyEdits, modify, type FormattingOptions } from 'jsonc-parser';
import {
  defaultConfig,
  parseConfig,
  CURRENT_SCHEMA_VERSION,
  type SymphonyConfig,
} from './config-schema.js';

/**
 * Phase 3H.1 — central `~/.symphony/` resolver + atomic config loader/writer.
 *
 * Single source of truth for the data dir. Pre-3H.1, four call sites
 * computed `path.join(os.homedir(), '.symphony', ...)` independently:
 *   - `src/state/path.ts:33` (DB path)
 *   - `src/rpc/auth.ts:64-66` (rpc.json)
 *   - `src/orchestrator/maestro/workspace.ts:32-33` (maestro/ subdir)
 *   - `src/index.ts:55,88` (CLI flag default)
 * 3H.1 routes all of them through `symphonyDataDir()` so future changes
 * (e.g. honoring `XDG_CONFIG_HOME` per-platform) land in one place.
 *
 * Atomic write follows the `writeRpcDescriptor` pattern from
 * `src/rpc/auth.ts:122-165`. Audit M1 (2B.2): `fs.writeFile(... { mode })`
 * only honors mode on CREATION — a pre-existing 0o644 file silently keeps
 * its mode. We open with explicit mode AND `chmod` to defend against that
 * on POSIX. Win32 chmod is a no-op (ACL-based), documented in known-gotchas.
 *
 * Comment-preserving writes use `jsonc-parser.modify + applyEdits`, the
 * same pattern Symphony already uses for `~/.claude/settings.local.json`
 * in `src/orchestrator/maestro/hook-installer.ts`. Users who edit their
 * config by hand and add `// my modelMode pick` survive a `saveConfig`
 * round-trip.
 */

const CONFIG_FILENAME = 'config.json';
const SYMPHONY_DATA_DIRNAME = '.symphony';
export const SYMPHONY_CONFIG_FILE_ENV = 'SYMPHONY_CONFIG_FILE' as const;

/** Pretty-printer settings for the on-disk file. Two-space indent matches `rpc.json`. */
const FORMATTING: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

/**
 * Resolve `~/.symphony/`. Single source of truth — every other call
 * site that needs to read/write files in this directory MUST go through
 * here.
 */
export function symphonyDataDir(home: string = os.homedir()): string {
  return path.join(home, SYMPHONY_DATA_DIRNAME);
}

/**
 * Resolve the config-file path.
 *
 * Precedence:
 *   1. `SYMPHONY_CONFIG_FILE` env var (absolute path; mirrors
 *      `SYMPHONY_DB_FILE`'s shape from `src/state/path.ts:28-32`).
 *      Used by tests and CI.
 *   2. `~/.symphony/config.json` default.
 *
 * Like `resolveDatabasePath`, this only resolves — callers must mkdir
 * the parent before opening.
 */
export function configFilePath(home?: string): string {
  const override = process.env[SYMPHONY_CONFIG_FILE_ENV]?.trim();
  if (override !== undefined && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(symphonyDataDir(home), CONFIG_FILENAME);
}

export type ConfigSource =
  | { readonly kind: 'default' }
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly warnings: readonly string[];
    };

export interface LoadResult {
  readonly config: SymphonyConfig;
  readonly source: ConfigSource;
}

/**
 * Read + parse the config file. Returns defaults on ENOENT (no file =
 * no config = defaults). Returns defaults + warnings on a file that's
 * present but malformed; the warnings string array is what the TUI
 * surfaces via toast.
 *
 * Sync wrt the file system (uses async fsp.readFile under the hood). The
 * file is small (<10 KB) so this adds <5ms to TUI mount even on a slow
 * disk.
 */
export async function loadConfig(filePath?: string): Promise<LoadResult> {
  const resolved = filePath !== undefined ? path.resolve(filePath) : configFilePath();
  let text: string;
  try {
    text = await fsp.readFile(resolved, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: defaultConfig(), source: { kind: 'default' } };
    }
    // Permissions / I/O failure — surface a warning but still let the
    // TUI mount with defaults. Crashing the boot for a config-read
    // problem is hostile.
    return {
      config: defaultConfig(),
      source: {
        kind: 'file',
        path: resolved,
        warnings: [`config.json read failed: ${describeError(cause)} — using defaults`],
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = text.trim().length === 0 ? {} : JSON.parse(text);
  } catch (cause) {
    return {
      config: defaultConfig(),
      source: {
        kind: 'file',
        path: resolved,
        warnings: [`config.json parse failed: ${describeError(cause)} — using defaults`],
      },
    };
  }
  const result = parseConfig(parsed);
  return {
    config: result.config,
    source: { kind: 'file', path: resolved, warnings: result.warnings },
  };
}

/**
 * Atomically persist `config` to disk with mode 0o600.
 *
 * Behavior:
 *   - Creates `~/.symphony/` (mode 0o700) if missing.
 *   - If the file does not exist, writes `JSON.stringify(config, null, 2)`.
 *   - If the file exists, runs `jsonc-parser.modify(text, [field], value)`
 *     for every top-level field in `config`, applying edits in document
 *     order so user comments and key ordering survive.
 *   - 0o600 mode enforced via `fs.open(path, 'w', 0o600)` then handle.chmod.
 *     Win32 chmod is a no-op for ACLs; documented gotcha.
 *
 * 3H.1 ships only `loadConfig` consumers (read-only display), but
 * `saveConfig` is exported now so 3H.2's edit affordances can land
 * with zero new I/O code. Smoke tested via unit tests in 3H.1.
 */
export async function saveConfig(config: SymphonyConfig, filePath?: string): Promise<void> {
  const resolved = filePath !== undefined ? path.resolve(filePath) : configFilePath();
  await fsp.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });

  let existingText: string | undefined;
  try {
    existingText = await fsp.readFile(resolved, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }

  const nextText =
    existingText === undefined || existingText.trim().length === 0
      ? `${JSON.stringify(config, null, 2)}\n`
      : applyConfigEdits(existingText, config);

  await writeFileAtomic600(resolved, nextText);
}

/**
 * Apply per-field edits to `existingText` so the on-disk file's comments
 * and unrelated formatting survive. Top-level fields are walked in a
 * stable order; nested objects are written via `value`-replace at the
 * top-level path (jsonc-parser handles structural edits idempotently).
 *
 * `keybindOverrides` is written as a single replace (record-shape) — we
 * do NOT walk individual key entries because that risks losing comments
 * inside the record. The whole record is a unit.
 */
function applyConfigEdits(existing: string, next: SymphonyConfig): string {
  const fields: ReadonlyArray<readonly [string, unknown]> = [
    ['schemaVersion', next.schemaVersion],
    ['modelMode', next.modelMode],
    ['maxConcurrentWorkers', next.maxConcurrentWorkers],
    // Phase 3O.1 — auto-merge policy. Keep in lockstep with `mergePatch`,
    // `SymphonyConfigPatch`, and `applyPatchInMemory` (config-context.tsx).
    // Skipping any of the four sites silently drops the field on rewrites.
    ['autoMerge', next.autoMerge],
    ['notifications', next.notifications],
    // Phase 3H.3 — top-level awayMode flag. New fields added to the
    // schema MUST also appear in this list, otherwise existing-file
    // writes silently drop the change (the schema-default fills in on
    // re-read, masking the missed write). Smoke: tests/scenarios/3h3.
    ['awayMode', next.awayMode],
    ['theme', next.theme],
    ['leaderTimeoutMs', next.leaderTimeoutMs],
    ['keybindOverrides', next.keybindOverrides],
    // defaultProjectPath is optional — only emit when set, omit otherwise.
    ...(next.defaultProjectPath !== undefined
      ? ([['defaultProjectPath', next.defaultProjectPath]] as const)
      : []),
  ];
  let text = existing;
  for (const [key, value] of fields) {
    const edits = modify(text, [key], value, { formattingOptions: FORMATTING });
    if (edits.length > 0) text = applyEdits(text, edits);
  }
  // If the user removed `defaultProjectPath` from the next config and it
  // was present on disk, drop it.
  if (next.defaultProjectPath === undefined) {
    const edits = modify(text, ['defaultProjectPath'], undefined, {
      formattingOptions: FORMATTING,
    });
    if (edits.length > 0) text = applyEdits(text, edits);
  }
  // Ensure trailing newline so `git diff` and POSIX tools are happy.
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

/**
 * Crash-atomic write with mode 0o600. Strategy: write to a sibling tmp
 * file, then rename over the destination.
 *
 * Why this pattern:
 *   - `fs.open(... 'w', 0o600)` truncates the destination at open. A
 *     SIGKILL between open and close leaves a half-written file.
 *     `loadConfig` then parses garbage → returns defaults + warning,
 *     silently destroying the user's persisted settings (3H.1 audit M3).
 *   - `fs.rename` is atomic on POSIX (same filesystem) and reasonably
 *     so on NTFS — readers see either the old file or the new file,
 *     never a partial state.
 *   - Random suffix on the tmp file avoids races between two Symphony
 *     processes saving concurrently. Mirrors the `writeMaestroClaudeMd`
 *     pattern in `src/orchestrator/maestro/workspace.ts:53`.
 *
 * 0o600 mode is set on the tmp file at open so the bytes are never
 * world-readable on disk. POSIX honors mode-on-create; Win32 chmod is
 * a no-op (ACL-based) — documented gotcha.
 *
 * On failure, the tmp file is best-effort unlinked. A leaked tmp won't
 * affect subsequent reads (different filename) but does waste disk.
 */
async function writeFileAtomic600(filePath: string, text: string): Promise<void> {
  const tmp = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(tmp, 'w', 0o600);
    await handle.writeFile(text, { encoding: 'utf8' });
    if (process.platform !== 'win32') {
      await handle.chmod(0o600);
    }
    await handle.close();
    handle = undefined;
    await fsp.rename(tmp, filePath);
  } catch (err) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code !== undefined ? `${code} ${cause.message}` : cause.message;
  }
  return String(cause);
}

/**
 * Phase 3H.2 — patch shape consumed by `applyPatchToDisk`. Mirrors the
 * React-side `SymphonyConfigPatch` from `config-context.tsx` so the
 * server-side RPC procedures and the TUI in-process setter feed the
 * same merge function. Top-level keys shallow-replace; the two nested
 * object fields (`theme`, `notifications`) merge partial-deep.
 *
 * `defaultProjectPath: null` clears the optional field; `undefined`
 * is the no-op. `keybindOverrides` replaces the entire record.
 */
export interface SymphonyConfigPatch {
  readonly modelMode?: SymphonyConfig['modelMode'];
  readonly maxConcurrentWorkers?: SymphonyConfig['maxConcurrentWorkers'];
  /**
   * Phase 3O.1 — auto-merge policy. Mirrors `awayMode`'s top-level pattern:
   * the AutoMergeDispatcher reads `loadConfig()` fresh per finalize event,
   * so no runtime-propagation seam is needed (unlike awayMode).
   */
  readonly autoMerge?: SymphonyConfig['autoMerge'];
  readonly notifications?: Partial<SymphonyConfig['notifications']>;
  /**
   * Phase 3H.3 — top-level `awayMode` flag. Top-level (rather than
   * nested under `notifications`) so Phase 3M's dedicated keybind /
   * status indicator can toggle it without reaching into a sub-object.
   */
  readonly awayMode?: SymphonyConfig['awayMode'];
  readonly theme?: Partial<SymphonyConfig['theme']>;
  readonly defaultProjectPath?: SymphonyConfig['defaultProjectPath'] | null;
  readonly leaderTimeoutMs?: SymphonyConfig['leaderTimeoutMs'];
  readonly keybindOverrides?: SymphonyConfig['keybindOverrides'];
}

/**
 * Phase 3H.2 — single-writer helper that serializes config writes within
 * THIS process. Reads disk fresh each call (no in-memory cache),
 * merges the patch, Zod-validates, and atomic-writes.
 *
 * Patch can be either a static `SymphonyConfigPatch` OR a function
 * `(current) => SymphonyConfigPatch`. The function form runs INSIDE the
 * serialized queue — after the fresh disk read — so rapid-fire callers
 * (e.g. `<leader>m m`) compute against the just-committed value rather
 * than a stale React render. Audit C2 (3H.2 commit 5 review).
 *
 * Two-process safety: this serializer covers concurrent calls inside ONE
 * process. Symphony's 3H.2 architecture funnels all writes through the
 * TUI's `<ConfigProvider>` (which calls this helper). The RPC handler
 * `mode.setModel` exists for future remote clients but is intentionally
 * NOT called by the in-process TUI — that keeps multi-writer races out
 * of 3H.2's critical path. Cross-process locking (POSIX `flock` / Win32
 * advisory locks) is a follow-up phase concern when remote clients land.
 *
 * On Zod validation failure, throws BEFORE touching disk; the queue
 * advances and the next caller sees the previous-on-disk state.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

export type SymphonyConfigPatchFn = (current: SymphonyConfig) => SymphonyConfigPatch;

export async function applyPatchToDisk(
  patch: SymphonyConfigPatch | SymphonyConfigPatchFn,
  filePath?: string,
): Promise<LoadResult> {
  const next = writeQueue.then(() => doApplyPatch(patch, filePath));
  // Don't let one rejection poison the queue — subsequent calls must
  // still serialize, not skip ahead.
  writeQueue = next.catch(() => undefined);
  return next;
}

async function doApplyPatch(
  patch: SymphonyConfigPatch | SymphonyConfigPatchFn,
  filePath?: string,
): Promise<LoadResult> {
  const resolved = filePath !== undefined ? path.resolve(filePath) : configFilePath();
  const current = await loadConfig(resolved);
  // Function-patch resolves AGAINST the fresh disk read — closes the
  // rapid-fire stale-state race that ref-mirroring alone can't (audit C2).
  const resolvedPatch = typeof patch === 'function' ? patch(current.config) : patch;
  const merged = mergePatch(current.config, resolvedPatch);
  // Use the schema's parse so out-of-range integers / unknown enums throw
  // BEFORE we hit `saveConfig`. Zod is the single source of truth for
  // field bounds.
  const { SymphonyConfigSchema } = await import('./config-schema.js');
  const next: SymphonyConfig = SymphonyConfigSchema.parse(merged);
  await saveConfig(next, resolved);
  return {
    config: next,
    source: { kind: 'file', path: resolved, warnings: [] },
  };
}

function mergePatch(current: SymphonyConfig, patch: SymphonyConfigPatch): SymphonyConfig {
  const next: SymphonyConfig = { ...current };
  if (patch.modelMode !== undefined) next.modelMode = patch.modelMode;
  if (patch.maxConcurrentWorkers !== undefined) next.maxConcurrentWorkers = patch.maxConcurrentWorkers;
  if (patch.leaderTimeoutMs !== undefined) next.leaderTimeoutMs = patch.leaderTimeoutMs;
  if (patch.awayMode !== undefined) next.awayMode = patch.awayMode;
  if (patch.autoMerge !== undefined) next.autoMerge = patch.autoMerge;
  if (patch.notifications !== undefined) {
    next.notifications = { ...current.notifications, ...patch.notifications };
  }
  if (patch.theme !== undefined) {
    next.theme = { ...current.theme, ...patch.theme };
  }
  if (patch.keybindOverrides !== undefined) next.keybindOverrides = patch.keybindOverrides;
  if ('defaultProjectPath' in patch) {
    if (patch.defaultProjectPath === null) {
      delete next.defaultProjectPath;
    } else if (patch.defaultProjectPath !== undefined) {
      next.defaultProjectPath = patch.defaultProjectPath;
    }
  }
  return next;
}

/**
 * Test seam — reset the in-process write queue between unit tests so
 * one test's pending write doesn't leak into the next test's setup.
 * Production callers MUST NOT call this.
 */
export function _resetConfigWriteQueue(): void {
  writeQueue = Promise.resolve();
}

export { defaultConfig, parseConfig, CURRENT_SCHEMA_VERSION };
export type { SymphonyConfig } from './config-schema.js';
