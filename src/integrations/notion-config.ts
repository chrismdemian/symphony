import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { TaskStatus } from '../state/types.js';
import { integrationsDir } from './secrets.js';

/**
 * Phase 8A — non-secret Notion connector config (`~/.symphony/integrations/
 * notion.json`). The API token is NOT here — it lives in a sibling 0o600
 * file via `secrets.ts`. Everything in this sidecar is safe to read:
 * database id, the resolved data-source id (a cache), the project's
 * property-name mappings, and the status/priority value maps.
 *
 * The maps have sensible defaults baked into `DEFAULT_NOTION_CONFIG` so the
 * on-disk file can be minimal (`databaseId` + the three property names);
 * advanced users override the maps by editing the JSON directly.
 */

export const NOTION_INTEGRATION = 'notion' as const;

/** Notion option name (compared case-insensitively) → Symphony task status. */
const StatusImportSchema = z.record(
  z.string(),
  z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']),
);

/** Notion option name (case-insensitive) → integer priority (higher = sooner). */
const PriorityImportSchema = z.record(z.string(), z.number().int());

export const NotionConfigSchema = z.object({
  /** The Notion database id the user pointed Symphony at (`--database`). */
  databaseId: z.string().min(1),
  /**
   * Resolved `data_source_id` for `databaseId` (cached after first
   * `databases.retrieve`). When a database exposes multiple data sources
   * the user can pin one here; otherwise the connector picks the first.
   */
  dataSourceId: z.string().min(1).optional(),
  /** Name of the Notion property mapped to task status. */
  statusProperty: z.string().min(1).default('Status'),
  /** Name of the Notion property mapped to project routing. */
  projectProperty: z.string().min(1).default('Project'),
  /** Name of the Notion property mapped to task priority. */
  priorityProperty: z.string().min(1).default('Priority'),
  /** Notion status/select value → Symphony status (import direction). */
  statusImport: StatusImportSchema.default({
    'to do': 'pending',
    'todo': 'pending',
    'not started': 'pending',
    'backlog': 'pending',
    'in progress': 'in_progress',
    'doing': 'in_progress',
    'in review': 'in_progress',
    'done': 'completed',
    'complete': 'completed',
    'completed': 'completed',
  }),
  /**
   * Symphony terminal status → Notion status/select value (writeback
   * direction). `completed` is always written back; `failed` only when a
   * value is configured (omit to leave failed tasks untouched in Notion).
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).default('Done'),
      failed: z.string().min(1).optional(),
    })
    .default({ completed: 'Done' }),
  /** Notion priority value → integer (import direction). */
  priorityImport: PriorityImportSchema.default({
    high: 2,
    medium: 1,
    low: 0,
  }),
});

export type NotionConfig = z.infer<typeof NotionConfigSchema>;

/** A fully-defaulted config given just a database id (handy for tests). */
export function defaultNotionConfig(databaseId: string): NotionConfig {
  return NotionConfigSchema.parse({ databaseId });
}

function notionConfigPath(home?: string): string {
  return path.join(integrationsDir(home), `${NOTION_INTEGRATION}.json`);
}

/**
 * Load + parse the Notion sidecar. Returns `undefined` when no file exists
 * (Notion not configured). Throws `NotionConfigError` on a present-but-
 * malformed file — a corrupt config must surface, never be treated as
 * "not configured".
 */
export async function loadNotionConfig(home?: string): Promise<NotionConfig | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(notionConfigPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new NotionConfigError(`notion.json is not valid JSON: ${(err as Error).message}`);
  }
  const result = NotionConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new NotionConfigError(`notion.json failed validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Persist the Notion sidecar (non-secret — plain write, not 0o600). Merges
 * `patch` over the existing config (or over defaults when none exists) so
 * `symphony config notion --database X` then `--status-prop Y` accumulate.
 * Returns the written config. `patch.databaseId` is required when no config
 * exists yet.
 */
export async function saveNotionConfig(
  patch: Partial<NotionConfig> & { databaseId?: string },
  home?: string,
): Promise<NotionConfig> {
  const existing = await loadNotionConfig(home);
  const databaseId = patch.databaseId ?? existing?.databaseId;
  if (databaseId === undefined || databaseId.length === 0) {
    throw new NotionConfigError(
      'A Notion database id is required. Pass --database <id> the first time you configure Notion.',
    );
  }
  // Re-parse through the schema so defaults fill in and the result is valid.
  const merged = NotionConfigSchema.parse({
    ...(existing ?? {}),
    ...stripUndefined(patch),
    databaseId,
  });
  const dir = integrationsDir(home);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(notionConfigPath(home), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

export class NotionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotionConfigError';
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * Case-insensitive lookup over a string-keyed record. The defaults ship
 * lowercased, but a USER-authored map (e.g. `{ "In Review": "in_progress" }`)
 * must still match a Notion value of any case — so we compare lowercased
 * keys rather than indexing directly (audit M3). The map is tiny (~10
 * entries) so the linear scan is negligible.
 */
function lookupCaseInsensitive<V>(
  map: Record<string, V>,
  value: string,
): V | undefined {
  const target = value.trim().toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === target) return map[key];
  }
  return undefined;
}

/**
 * Map a Notion status/select value to a Symphony status using `statusImport`
 * (case-insensitive). Returns `undefined` for unmapped values so the caller
 * can fall back to `'pending'` and log the unknown value.
 */
export function mapNotionStatus(config: NotionConfig, notionValue: string): TaskStatus | undefined {
  return lookupCaseInsensitive(config.statusImport, notionValue);
}

/**
 * Map a Notion priority value to an integer using `priorityImport`
 * (case-insensitive). Returns `undefined` for unmapped values.
 */
export function mapNotionPriority(config: NotionConfig, notionValue: string): number | undefined {
  return lookupCaseInsensitive(config.priorityImport, notionValue);
}
