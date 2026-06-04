import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { integrationsDir } from './secrets.js';
import type { StatusClassification, TaskFormat } from './obsidian-parser.js';
import { defaultStatusMap } from './obsidian-parser.js';

/**
 * Phase 8B — non-secret Obsidian connector config (`~/.symphony/integrations/
 * obsidian.json`). Unlike Notion there is NO token: a vault is a folder of
 * markdown on the local disk, so `secrets.ts` isn't used at all. Everything
 * here is safe to read — the vault path, property mappings, and the
 * status/priority value maps.
 *
 * Defaults are baked into the schema so the on-disk file can be minimal
 * (just `vaultPath`); advanced users override the maps by editing the JSON.
 */

export const OBSIDIAN_INTEGRATION = 'obsidian' as const;

const TaskFormatSchema = z.enum(['emoji', 'dataview', 'auto']);

/** Obsidian status char → Symphony status (import direction). */
const StatusImportSchema = z.record(
  z.string(),
  z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']),
);

/** Marks which imported statuses are "terminal in Obsidian" (skip on sync). */
const StatusTerminalSchema = z.record(z.string(), z.boolean());

/** Tasks-plugin priority signifier (emoji or word) → integer (higher sooner). */
const PriorityImportSchema = z.record(z.string(), z.number().int());

export const ObsidianConfigSchema = z.object({
  /** Absolute path to the Obsidian vault root (`--vault`). */
  vaultPath: z.string().min(1),
  /**
   * Which task-metadata format the vault uses. `auto` (default) sniffs the
   * first task lines per file; pin `emoji` / `dataview` to skip detection.
   */
  taskFormat: TaskFormatSchema.default('auto'),
  /**
   * Note-level YAML frontmatter key carrying the project route, e.g.
   * `project: symphony`. Matched against a registered project name/id.
   */
  projectProperty: z.string().min(1).default('project'),
  /** Whether to run the live chokidar watcher (auto-create tasks on edit). */
  watch: z.boolean().default(true),
  /** Glob-ish path fragments to exclude (matched as substrings, posix-normalized). */
  exclude: z.array(z.string()).default(['.trash/', '.obsidian/']),
  /**
   * Obsidian status char → `{ status, terminal }`. The defaults come from
   * `obsidian-parser`'s built-in map; a user override is MERGED over the
   * defaults (so adding one custom char doesn't wipe the rest).
   */
  statusImport: StatusImportSchema.optional(),
  statusTerminal: StatusTerminalSchema.optional(),
  /**
   * Symphony terminal status → Obsidian writeback. `completed` is always
   * written (default char `x`); `failed` only when a char is configured
   * (omit to leave failed tasks untouched). `appendDoneDate` adds the
   * Tasks-plugin `✅ YYYY-MM-DD` stamp when completing.
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).max(1).default('x'),
      failed: z.string().min(1).max(1).optional(),
      appendDoneDate: z.boolean().default(true),
    })
    .default({ completed: 'x', appendDoneDate: true }),
  /** Tasks priority signifier → integer (import direction). */
  priorityImport: PriorityImportSchema.default({
    highest: 3,
    high: 2,
    medium: 1,
    low: -1,
    lowest: -2,
  }),
});

export type ObsidianConfig = z.infer<typeof ObsidianConfigSchema>;

export class ObsidianConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObsidianConfigError';
  }
}

/** A fully-defaulted config given just a vault path (handy for tests). */
export function defaultObsidianConfig(vaultPath: string): ObsidianConfig {
  return ObsidianConfigSchema.parse({ vaultPath });
}

function obsidianConfigPath(home?: string): string {
  return path.join(integrationsDir(home), `${OBSIDIAN_INTEGRATION}.json`);
}

/**
 * Load + parse the Obsidian sidecar. Returns `undefined` when no file exists
 * (Obsidian not configured). Throws `ObsidianConfigError` on a present-but-
 * malformed file — a corrupt config must surface, never be treated as "not
 * configured".
 */
export async function loadObsidianConfig(
  home?: string,
): Promise<ObsidianConfig | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(obsidianConfigPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ObsidianConfigError(
      `obsidian.json is not valid JSON: ${(err as Error).message}`,
    );
  }
  const result = ObsidianConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ObsidianConfigError(
      `obsidian.json failed validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Persist the Obsidian sidecar (non-secret — plain write). Merges `patch`
 * over the existing config (or over defaults) so successive
 * `symphony config obsidian` calls accumulate. `patch.vaultPath` is required
 * when no config exists yet. The vault path is stored resolved to absolute.
 */
export async function saveObsidianConfig(
  patch: Partial<ObsidianConfig> & { vaultPath?: string },
  home?: string,
): Promise<ObsidianConfig> {
  const existing = await loadObsidianConfig(home);
  const rawVault = patch.vaultPath ?? existing?.vaultPath;
  if (rawVault === undefined || rawVault.length === 0) {
    throw new ObsidianConfigError(
      'An Obsidian vault path is required. Pass --vault <path> the first time you configure Obsidian.',
    );
  }
  const merged = ObsidianConfigSchema.parse({
    ...(existing ?? {}),
    ...stripUndefined(patch),
    vaultPath: path.resolve(rawVault),
  });
  const dir = integrationsDir(home);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    obsidianConfigPath(home),
    `${JSON.stringify(merged, null, 2)}\n`,
    'utf8',
  );
  return merged;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Build the effective status-char → classification map: the parser's built-in
 * defaults with any per-char user overrides from `statusImport` /
 * `statusTerminal` merged on top. A char present in `statusImport` but not
 * `statusTerminal` keeps the default terminal flag (or `false` for a new char).
 */
export function resolveStatusMap(
  config: ObsidianConfig,
): Record<string, StatusClassification> {
  const map = defaultStatusMap();
  if (config.statusImport !== undefined) {
    for (const [char, status] of Object.entries(config.statusImport)) {
      const terminal =
        config.statusTerminal?.[char] ?? map[char]?.terminal ?? false;
      map[char] = { status, terminal };
    }
  }
  // A statusTerminal override for an otherwise-default char still applies.
  if (config.statusTerminal !== undefined) {
    for (const [char, terminal] of Object.entries(config.statusTerminal)) {
      const status = map[char]?.status ?? 'pending';
      map[char] = { status, terminal };
    }
  }
  return map;
}

/** Resolve the effective task format (alias for the config field, for callers). */
export function resolveTaskFormat(config: ObsidianConfig): TaskFormat {
  return config.taskFormat;
}
