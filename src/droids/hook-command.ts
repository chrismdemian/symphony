import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// `fileURLToPath` is used by `resolveFenceHookScript` below to walk
// `import.meta.url`-relative candidates; `pathToFileURL` normalizes the
// tsx loader specifier so `--import` accepts it on Windows (Node 22+
// rejects raw absolute paths with `ERR_UNSUPPORTED_ESM_URL_SCHEME`).

import { prependTsxLoaderIfTs } from '../utils/node-runner.js';
import { resolveDroidToolPolicy, type DroidDefinition } from './types.js';

/**
 * Phase 4F.1 — resolve the fence-hook script + build the static
 * settings.local.json command for it.
 *
 * The hook ships as a SEPARATE tsup entry (`src/droids/fence-hook.ts` →
 * `dist/droids/fence-hook.js`) — a per-tool-call HTTP round-trip to a
 * sidecar (the Stop-hook pattern) would tax every Write/Edit and add a
 * server surface; a synchronous standalone script is deterministic and
 * serverless (plan decision #2). Production runs the bundled `.js`; dev
 * (`pnpm dev` / vitest) runs the `.ts` via tsx.
 */

/** Env var carrying the JSON tool/write policy (read by fence-hook). */
export const DROID_FENCE_ENV = 'SYMPHONY_DROID_FENCE' as const;
/** Env var carrying the absolute worktree root (write-containment). */
export const DROID_WORKTREE_ENV = 'SYMPHONY_DROID_WORKTREE' as const;
/**
 * Inert argv token on the hook command. Doubles as the
 * strip-by-marker substring so re-installing the hook into a reused
 * worktree's settings.local.json replaces (never accumulates) the
 * Symphony entry, and never matches a user-authored hook. Mirrors the
 * Stop hook's `$SYMPHONY_HOOK_PORT` marker role.
 */
export const DROID_FENCE_MARKER = '--symphony-droid-fence' as const;

export class FenceHookResolveError extends Error {
  constructor(
    message: string,
    public readonly candidates: readonly string[],
  ) {
    super(message);
    this.name = 'FenceHookResolveError';
  }
}

export interface ResolveFenceHookOptions {
  /** Test seam — skip filesystem probing, use this exact script path. */
  readonly overrideScript?: string;
  /** Test seam — resolve relative to this module URL. */
  readonly moduleUrl?: string;
}

/**
 * Locate the fence-hook script. Mirrors `resolveMaestroPromptsDir`'s
 * candidate-walk: bundled (`dist/droids/fence-hook.js`, this module
 * bundled into `dist/index.js` ⇒ `here === dist/`) first, then the
 * dev/tsx source (`src/droids/fence-hook.ts`).
 */
export function resolveFenceHookScript(
  options: ResolveFenceHookOptions = {},
): string {
  if (options.overrideScript !== undefined) return options.overrideScript;
  const here = path.dirname(
    fileURLToPath(options.moduleUrl ?? import.meta.url),
  );
  const candidates = [
    // bundled: dist/index.js → here=dist/ → dist/droids/fence-hook.js
    path.resolve(here, 'droids', 'fence-hook.js'),
    // adjacency / alt bundle layouts
    path.resolve(here, 'fence-hook.js'),
    path.resolve(here, '..', 'droids', 'fence-hook.js'),
    // dev (tsx / vitest): here=src/droids/ → src/droids/fence-hook.ts
    path.resolve(here, 'fence-hook.ts'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  throw new FenceHookResolveError(
    `Could not locate the droid fence-hook script. Tried:\n  - ${candidates.join(
      '\n  - ',
    )}\nRebuild via \`pnpm build\` to populate dist/droids/fence-hook.js.`,
    candidates,
  );
}

/** Double-quote a path for cross-shell hook commands (cmd + POSIX sh). */
function quotePath(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}

/**
 * The static command Claude Code runs for every PreToolUse event in a
 * fenced droid's worktree. The policy rides env vars (set on the worker
 * spawn, exempted from the SYMPHONY_* blocklist) so this string is
 * stable + free of shell-escaped JSON. NEVER suffix with `|| true` —
 * exit 2 IS the block (Claude Code `hooks.md`).
 *
 * Dev (`.ts`) resolves the tsx loader to an ABSOLUTE specifier via
 * `import.meta.resolve` from Symphony's own deps — the hook runs with
 * cwd = the worktree (a different project), so a bare `tsx` specifier
 * would resolve against the wrong node_modules. Production (`.js`)
 * needs no loader.
 */
export function buildDroidFenceHookCommand(
  options: ResolveFenceHookOptions = {},
): string {
  const script = resolveFenceHookScript(options);
  if (!script.endsWith('.ts')) {
    return `node ${quotePath(script)} ${DROID_FENCE_MARKER}`;
  }
  // Dev path — make `--import tsx` cwd-independent. `import.meta.resolve`
  // returns either a `file:` URL OR (notably on Windows / Node 22+) a
  // raw absolute path; Node's `--import` rejects raw absolute paths
  // (`ERR_UNSUPPORTED_ESM_URL_SCHEME`), so normalize every absolute
  // result to a `file://` URL via `pathToFileURL`. A bare specifier is
  // left as-is for the fallback (works when cwd has tsx — documented
  // dev limitation; production uses the bundled `.js` and skips this).
  let importSpec = 'tsx';
  try {
    const resolved = import.meta.resolve('tsx');
    if (typeof resolved === 'string' && resolved.length > 0) {
      const asUrl = resolved.startsWith('file:')
        ? resolved
        : path.isAbsolute(resolved)
          ? pathToFileURL(resolved).href
          : resolved;
      importSpec = quotePath(asUrl);
    }
  } catch {
    importSpec = 'tsx';
  }
  const args = prependTsxLoaderIfTs([script, DROID_FENCE_MARKER]).map((a) =>
    a === script ? quotePath(a) : a === 'tsx' ? importSpec : a,
  );
  return `node ${args.join(' ')}`;
}

export interface DroidFenceEnv {
  /** `extraEnv` to merge onto the worker spawn config. */
  readonly env: Record<string, string>;
  /**
   * Keys to pass as `WorkerConfig.allowExtraEnvKeys` — both vars are
   * `SYMPHONY_*`-prefixed and would otherwise be stripped by the
   * worker env blocklist (`src/workers/env.ts`).
   */
  readonly allowKeys: readonly string[];
}

/**
 * Build the env that ships the droid's policy to the fence-hook. The
 * policy travels as JSON in one var (delimiter-safe for write_path
 * globs); the worktree root is its own var for write-containment.
 */
export function buildDroidFenceEnv(
  def: DroidDefinition,
  worktreeRoot: string,
): DroidFenceEnv {
  const policy = resolveDroidToolPolicy(def);
  return {
    env: {
      [DROID_FENCE_ENV]: JSON.stringify({
        allowed: policy.allowed,
        denied: policy.denied,
        writePaths: policy.writePaths,
      }),
      [DROID_WORKTREE_ENV]: worktreeRoot,
    },
    allowKeys: [DROID_FENCE_ENV, DROID_WORKTREE_ENV],
  };
}

/**
 * Does this droid declare ANY enforceable policy? A droid with no tool
 * lists AND no write_paths gets no fence hook + no policy env (parity
 * with built-in roles — zero spawn-path change). The parser already
 * rejects a fully-empty policy, so in practice every parsed droid is
 * fenced; this guard keeps the spawn integration honest if that ever
 * changes.
 */
export function droidIsFenced(def: DroidDefinition): boolean {
  const p = resolveDroidToolPolicy(def);
  return p.allowed.length > 0 || p.denied.length > 0 || p.writePaths.length > 0;
}
