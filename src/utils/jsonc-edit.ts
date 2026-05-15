import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type JSONPath,
  type ParseError,
  type ParseOptions,
} from 'jsonc-parser';

/**
 * Phase 4D.5 — canonical format-preserving JSONC editing.
 *
 * Symphony writes into user-facing JSONC files Claude Code owns
 * (`~/.claude.json`, `<worktree>/.claude/settings.local.json`, etc.).
 * Those files frequently carry user comments and hand-tuned formatting.
 * `JSON.parse → mutate → JSON.stringify` destroys both. This module is
 * the ONE place that does it correctly: `jsonc-parser.modify()` +
 * `applyEdits()` produce a minimal diff that preserves everything else.
 *
 * Port of emdash `mcp/configIO.ts:111-120` (validate-then-modify) +
 * `ClaudeHookService.ts:33-51` (strip-own-entries-by-marker).
 *
 * NOTE: shipped callers `ensureClaudeTrust` (Phase 1B) and the Maestro
 * Stop-hook installer (Phase 2C.2) still use their own inline edits.
 * Retrofitting them onto this primitive is a deliberate follow-up (it
 * would re-touch shipped, regression-locked phases) — tracked in the
 * 4D phase review, not done here.
 */

const JSONC_PARSE_OPTIONS: ParseOptions = {
  allowTrailingComma: true,
  disallowComments: false,
};

/** Two-space indent, LF — matches `rpc.json` / `config.json` house style. */
export const DEFAULT_JSONC_FORMATTING: FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

export class JsoncParseError extends Error {
  constructor(
    message: string,
    public readonly file: string | undefined,
  ) {
    super(message);
    this.name = 'JsoncParseError';
  }
}

/**
 * Validate that `raw` is well-formed JSONC whose root is an object, and
 * return the parsed value. Most callers DISCARD the return — the point
 * is to fail fast (throwing {@link JsoncParseError}) BEFORE computing
 * edits against a corrupt file, exactly as emdash's `parseJsoncConfig`
 * does (`configIO.ts:16-34`).
 */
export function parseJsoncObject(
  raw: string,
  opts: { file?: string } = {},
): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, JSONC_PARSE_OPTIONS) as unknown;
  if (
    errors.length > 0 ||
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    const detail =
      errors.length > 0
        ? errors.map((e) => printParseErrorCode(e.error)).join(', ')
        : 'root value must be an object';
    throw new JsoncParseError(
      `failed to parse JSONC${opts.file !== undefined ? ` at ${opts.file}` : ''}: ${detail}`,
      opts.file,
    );
  }
  return parsed as Record<string, unknown>;
}

export interface ModifyJsoncOptions {
  /** Override the 2-space/LF default. */
  readonly formatting?: FormattingOptions;
  /**
   * Validate `raw` parses before editing (default true). The one reason
   * to disable: the caller already validated this exact string.
   */
  readonly validate?: boolean;
  /** Surfaced in {@link JsoncParseError} messages. */
  readonly file?: string;
}

/**
 * Format-preserving edit at a single JSON path. `value: undefined`
 * DELETES the path (jsonc-parser semantics). Returns the original string
 * unchanged when the edit is a no-op (idempotent re-apply). Never
 * round-trips through `JSON.parse`/`stringify`.
 */
export function modifyJsonc(
  raw: string,
  jsonPath: JSONPath,
  value: unknown,
  options: ModifyJsoncOptions = {},
): string {
  const shouldValidate = options.validate !== false && raw.trim().length > 0;
  if (shouldValidate) {
    parseJsoncObject(raw, options.file !== undefined ? { file: options.file } : {});
  }
  const edits = modify(raw, jsonPath, value, {
    formattingOptions: options.formatting ?? DEFAULT_JSONC_FORMATTING,
  });
  return edits.length > 0 ? applyEdits(raw, edits) : raw;
}

/**
 * Strip-by-marker (emdash `ClaudeHookService.ts:33-51`). Returns the
 * entries whose JSON serialization does NOT contain `marker` — i.e.
 * drops Symphony-owned (stale) entries while preserving user-authored
 * ones. The marker must be a string that appears in every entry
 * Symphony writes but never in a user entry (e.g. an env-var name like
 * `SYMPHONY_HOOK_PORT`). Used on re-inject so own entries don't
 * accumulate.
 */
export function stripOwnEntriesByMarker<T>(
  entries: readonly T[],
  marker: string,
): T[] {
  return entries.filter((entry) => !JSON.stringify(entry).includes(marker));
}

export interface JsoncEdit {
  readonly path: JSONPath;
  readonly value: unknown;
}

export interface EditJsoncFileOptions {
  /**
   * POSIX mode for the written file. Only honored on CREATE by the OS,
   * so we open + chmod explicitly. Win32 chmod is a no-op (ACL-based).
   * Omit for non-secret files (default umask applies).
   */
  readonly mode?: number;
  /** Reuse the parsed value if the file is fresh-created. */
  readonly emptyTemplate?: string;
}

/**
 * Read → apply edits (in order) → atomic write, preserving comments and
 * untouched formatting. A missing file is treated as `{}` (or
 * `emptyTemplate`) so first-write is uniform. Crash-atomic via
 * tmp+rename (a SIGKILL mid-write can't truncate the user's real file).
 */
export async function editJsoncFile(
  filePath: string,
  edits: readonly JsoncEdit[],
  options: EditJsoncFileOptions = {},
): Promise<void> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    raw = '';
  }
  let text =
    raw.trim().length === 0 ? (options.emptyTemplate ?? '{}\n') : raw;
  if (text.trim().length > 0) {
    parseJsoncObject(text, { file: filePath });
  }
  for (const edit of edits) {
    const ed = modify(text, edit.path, edit.value, {
      formattingOptions: DEFAULT_JSONC_FORMATTING,
    });
    if (ed.length > 0) text = applyEdits(text, ed);
  }
  if (!text.endsWith('\n')) text += '\n';
  await writeFileAtomic(filePath, text, options.mode);
}

/**
 * tmp+rename atomic write. Mirrors the documented
 * `config.ts:writeFileAtomic600` / `workspace.ts:writeMaestroClaudeMd`
 * pattern. Random tmp suffix avoids concurrent-writer collisions; both
 * finish, the later rename wins, neither reader sees a partial file.
 */
async function writeFileAtomic(
  filePath: string,
  text: string,
  mode?: number,
): Promise<void> {
  const tmp = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  let handle: Awaited<ReturnType<typeof fsp.open>> | undefined;
  try {
    handle = await fsp.open(tmp, 'w', mode ?? 0o644);
    await handle.writeFile(text, { encoding: 'utf8' });
    if (mode !== undefined && process.platform !== 'win32') {
      await handle.chmod(mode);
    }
    await handle.close();
    handle = undefined;
    await fsp.rename(tmp, filePath);
  } catch (err) {
    if (handle !== undefined) await handle.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}
