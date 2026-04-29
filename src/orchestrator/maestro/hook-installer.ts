import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as jsoncParser from 'jsonc-parser';

const SETTINGS_FILENAME = 'settings.local.json';
const DEFAULT_MARKER = 'SYMPHONY_HOOK_PORT';
const STOP_HOOK_KEY = 'Stop' as const;

// Audit C1: per-claudeDir async-mutex chain. Two concurrent
// installStopHook/uninstallStopHook calls against the same `.claude/` dir
// would otherwise race read→modify→atomicWrite and clobber each other's
// entries. Promise-chained, so the cost when uncontended is ~one extra
// microtask tick.
const claudeDirMutexes = new Map<string, Promise<void>>();

async function withClaudeDirLock<T>(claudeDir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(claudeDir);
  const prev = claudeDirMutexes.get(key) ?? Promise.resolve();
  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  claudeDirMutexes.set(key, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release!();
    // Best-effort GC: if we're the tail of the chain, drop the entry.
    if (claudeDirMutexes.get(key) === prev.then(() => next)) {
      claudeDirMutexes.delete(key);
    }
  }
}

const JSONC_PARSE_OPTIONS: jsoncParser.ParseOptions = {
  allowTrailingComma: true,
  disallowComments: false,
};

const JSONC_FORMAT_OPTIONS: jsoncParser.FormattingOptions = {
  insertSpaces: true,
  tabSize: 2,
  eol: '\n',
};

export interface InstallStopHookInput {
  /** Directory containing (or to receive) `settings.local.json`. */
  claudeDir: string;
  /** Bound port of `MaestroHookServer`. */
  port: number;
  /**
   * Substring used to identify Symphony entries on re-install (idempotent
   * marker-strip). Defaults to `SYMPHONY_HOOK_PORT` — the env-var literal
   * embedded in the curl command, which never appears in user hooks.
   */
  marker?: string;
}

export interface UninstallStopHookInput {
  claudeDir: string;
  marker?: string;
}

interface StopHookEntry {
  hooks: Array<{ type: 'command'; command: string }>;
}

/**
 * Build the curl literal Claude Code runs on every Stop event. Reads
 * `$SYMPHONY_HOOK_TOKEN` and `$SYMPHONY_HOOK_PORT` from Maestro's environment
 * (the launcher passes both via `extraEnv` + `allowExtraEnvKeys`).
 *
 * Headers, not body, carry the token + event type — body is piped via
 * `-d @-` to avoid shell expansion of `$`/backticks/quotes in payload text
 * (gotcha shared with emdash `ClaudeHookService.ts:7-13`).
 *
 * `|| true` because Claude Code aborts the session on non-zero hook exit
 * (Known Gotcha; emdash `ClaudeHookService.ts:22`).
 */
export function buildStopHookCommand(): string {
  return (
    'curl -sf -X POST ' +
    '-H "Content-Type: application/json" ' +
    '-H "X-Symphony-Hook-Token: $SYMPHONY_HOOK_TOKEN" ' +
    '-H "X-Symphony-Hook-Event: stop" ' +
    '-d @- ' +
    '"http://127.0.0.1:$SYMPHONY_HOOK_PORT/hook" || true'
  );
}

/**
 * Inject Symphony's Stop hook into `<claudeDir>/settings.local.json`.
 * Preserves user-defined hooks + JSONC comments via `jsonc-parser` modify
 * + applyEdits (Known Gotcha; emdash `mcp/configIO.ts:111-119`).
 *
 * Idempotent — repeated calls strip prior Symphony entries (identified by
 * the `marker` substring) before re-appending. Atomic write-then-rename
 * guards against partial writes (mirrors `workspace.ts:53-62`).
 */
export async function installStopHook(input: InstallStopHookInput): Promise<void> {
  return withClaudeDirLock(input.claudeDir, async () => {
    const marker = input.marker ?? DEFAULT_MARKER;
    const settingsPath = path.join(input.claudeDir, SETTINGS_FILENAME);
    await fsp.mkdir(input.claudeDir, { recursive: true });

    const command = buildStopHookCommand();
    const symphonyEntry: StopHookEntry = {
      hooks: [{ type: 'command', command }],
    };

    const existing = await readExisting(settingsPath);
    const filteredEntries = filterOutMarker(existing.stopEntries, marker);
    const nextEntries = [...filteredEntries, symphonyEntry];

    if (existing.rawText === undefined) {
      const body = { hooks: { [STOP_HOOK_KEY]: nextEntries } };
      await atomicWrite(settingsPath, JSON.stringify(body, null, 2) + '\n');
      return;
    }

    const edits = jsoncParser.modify(
      existing.rawText,
      ['hooks', STOP_HOOK_KEY],
      nextEntries,
      { formattingOptions: JSONC_FORMAT_OPTIONS },
    );
    const modified = jsoncParser.applyEdits(existing.rawText, edits);
    await atomicWrite(settingsPath, modified);
  });
}

/**
 * Strip Symphony's Stop hook from `<claudeDir>/settings.local.json`. No-op
 * if the file or the `Stop` key doesn't exist. Preserves user hooks +
 * comments (jsonc-parser).
 */
export async function uninstallStopHook(input: UninstallStopHookInput): Promise<void> {
  return withClaudeDirLock(input.claudeDir, async () => {
    const marker = input.marker ?? DEFAULT_MARKER;
    const settingsPath = path.join(input.claudeDir, SETTINGS_FILENAME);
    const existing = await readExisting(settingsPath);
    if (existing.rawText === undefined) return;

    const filtered = filterOutMarker(existing.stopEntries, marker);
    if (filtered.length === existing.stopEntries.length) {
      // Nothing to remove.
      return;
    }
    const edits = jsoncParser.modify(
      existing.rawText,
      ['hooks', STOP_HOOK_KEY],
      filtered.length > 0 ? filtered : undefined,
      { formattingOptions: JSONC_FORMAT_OPTIONS },
    );
    const modified = jsoncParser.applyEdits(existing.rawText, edits);
    await atomicWrite(settingsPath, modified);
  });
}

interface ExistingSettings {
  /** Raw file text — `undefined` if file missing or unreadable. */
  rawText: string | undefined;
  /** Existing `hooks.Stop` array (empty if absent). */
  stopEntries: unknown[];
}

async function readExisting(settingsPath: string): Promise<ExistingSettings> {
  let rawText: string;
  try {
    rawText = await fsp.readFile(settingsPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { rawText: undefined, stopEntries: [] };
    }
    throw err;
  }

  const parseErrors: jsoncParser.ParseError[] = [];
  const parsed = jsoncParser.parse(rawText, parseErrors, JSONC_PARSE_OPTIONS) as unknown;
  if (parseErrors.length > 0) {
    const summary = parseErrors
      .map((e) => jsoncParser.printParseErrorCode(e.error))
      .join(', ');
    throw new Error(
      `MaestroHookInstaller: failed to parse ${settingsPath} (${summary}). ` +
        'Hand-fix the JSONC and retry.',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `MaestroHookInstaller: ${settingsPath} root must be a JSON object`,
    );
  }
  const stopEntries = extractStopEntries(parsed as Record<string, unknown>);
  return { rawText, stopEntries };
}

function extractStopEntries(root: Record<string, unknown>): unknown[] {
  const hooks = root['hooks'];
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  const stop = (hooks as Record<string, unknown>)[STOP_HOOK_KEY];
  if (!Array.isArray(stop)) return [];
  return stop;
}

function filterOutMarker(entries: unknown[], marker: string): unknown[] {
  return entries.filter((entry) => !entryContainsMarker(entry, marker));
}

function entryContainsMarker(entry: unknown, marker: string): boolean {
  try {
    const serialized = JSON.stringify(entry);
    if (typeof serialized !== 'string') return false;
    return serialized.includes(marker);
  } catch {
    // Circular-ref / un-stringifiable entries are not Symphony's.
    return false;
  }
}

async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const tmp = `${targetPath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, targetPath);
  } catch (err) {
    fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}
