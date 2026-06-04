import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { integrationsDir } from './secrets.js';

/**
 * Phase 8C — non-secret Linear connector config (`~/.symphony/integrations/
 * linear.json`). The API key is NOT here — it lives in the OS keychain (or a
 * sibling 0o600 file) via `secrets.ts`.
 *
 * Unlike Notion, Linear needs no required config field — the API key alone is
 * enough to pull issues. Everything here is optional:
 *   - `teamKey`        — scope the sync to one team (e.g. "ENG"); omit for all.
 *   - `statusWriteback`— override the workflow state NAMES used on completion.
 *     `completed` is auto-resolved (first `completed`-type state) when omitted;
 *     `failed` writeback only happens when a name is configured (Notion convention).
 */

export const LINEAR_INTEGRATION = 'linear' as const;

export const LinearConfigSchema = z.object({
  /** Restrict the sync to a single team by key (e.g. "ENG"). Omit for all teams. */
  teamKey: z.string().min(1).optional(),
  /**
   * Symphony terminal status → Linear workflow state name (writeback direction).
   * `completed` auto-resolves to the team's first `completed`-type state when
   * omitted; set a name to force a specific one. `failed` writeback only fires
   * when configured (omit to leave failed tasks untouched in Linear).
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).optional(),
      failed: z.string().min(1).optional(),
    })
    .default({}),
});

export type LinearConfig = z.infer<typeof LinearConfigSchema>;

/** A fully-defaulted config (handy for tests + the token-only configure path). */
export function defaultLinearConfig(): LinearConfig {
  return LinearConfigSchema.parse({});
}

function linearConfigPath(home?: string): string {
  return path.join(integrationsDir(home), `${LINEAR_INTEGRATION}.json`);
}

/**
 * Load + parse the Linear sidecar. Returns `undefined` when no file exists.
 * Throws `LinearConfigError` on a present-but-malformed file — a corrupt config
 * must surface, never be treated as "not configured".
 */
export async function loadLinearConfig(home?: string): Promise<LinearConfig | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(linearConfigPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LinearConfigError(`linear.json is not valid JSON: ${(err as Error).message}`);
  }
  const result = LinearConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new LinearConfigError(`linear.json failed validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Persist the Linear sidecar (non-secret — plain write). Merges `patch` over
 * the existing config (or defaults) so successive `symphony config linear`
 * invocations accumulate. Returns the written config.
 */
export async function saveLinearConfig(
  patch: Partial<LinearConfig>,
  home?: string,
): Promise<LinearConfig> {
  const existing = await loadLinearConfig(home);
  const merged = LinearConfigSchema.parse({
    ...(existing ?? {}),
    ...stripUndefined(patch),
  });
  const dir = integrationsDir(home);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(linearConfigPath(home), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

export class LinearConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearConfigError';
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}
