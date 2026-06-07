import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { integrationsDir } from './secrets.js';

/**
 * Phase 8C.4 — non-secret Plain connector config (`~/.symphony/integrations/
 * plain.json`). The API key is NOT here — it lives in the OS keychain (or a
 * sibling 0o600 file) via `secrets.ts`.
 *
 * Plain is a GraphQL customer-support tool. Like Linear (and unlike GitHub /
 * GitLab / Forgejo) it activates on a TOKEN ALONE — there's no required
 * `repos`/`projects` field; a key can read the whole workspace's threads.
 * Everything is optional:
 *   - `apiUrl`        — the Plain Core API GraphQL endpoint. Default is the UK
 *     region (`https://core-api.uk.plain.com/graphql/v1`); override for other
 *     regions. MUST be https (http allowed only for localhost) — the key rides it.
 *   - `statuses`      — which Plain thread statuses count as "open" to import.
 *     Default `["TODO"]`. `DONE` threads are terminal and skipped by the ingest
 *     regardless; include `SNOOZED` to also pull snoozed threads.
 *   - `statusWriteback`— the internal NOTE text posted on completion / failure.
 *     `completed` always posts the note then marks the thread DONE; `failed`
 *     writeback only happens when a template is configured (Linear/Notion
 *     convention) and NEVER marks done — a failed task leaves the thread open.
 *     The note is an INTERNAL note, never a customer-facing reply.
 */

export const PLAIN_INTEGRATION = 'plain' as const;

/** Plain's three thread statuses. */
export const PLAIN_THREAD_STATUSES = ['TODO', 'SNOOZED', 'DONE'] as const;
export type PlainThreadStatus = (typeof PLAIN_THREAD_STATUSES)[number];

export const PlainConfigSchema = z.object({
  /**
   * Plain Core API GraphQL endpoint. Omit for the UK region default. MUST be
   * https (http allowed only for localhost) — the API key rides this URL, so a
   * non-TLS / arbitrary host is a leak surface.
   */
  apiUrl: z
    .string()
    .url()
    .refine(
      (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(u),
      'apiUrl must be https:// (http:// is allowed only for localhost)',
    )
    .optional(),
  /** Thread statuses to import (default `["TODO"]`). `DONE` is skipped anyway. */
  statuses: z
    .array(z.enum(PLAIN_THREAD_STATUSES))
    .nonempty('at least one status')
    .default(['TODO']),
  /**
   * Symphony terminal status → Plain thread INTERNAL note text (writeback
   * direction). `completed` posts the note then marks the thread DONE; a default
   * completion note is used when omitted. `failed` writeback only fires when
   * configured (omit to leave failed tasks' threads untouched), and never marks done.
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).optional(),
      failed: z.string().min(1).optional(),
    })
    .default({}),
});

export type PlainConfig = z.infer<typeof PlainConfigSchema>;

/** A fully-defaulted config (handy for tests + the token-only configure path). */
export function defaultPlainConfig(): PlainConfig {
  return PlainConfigSchema.parse({});
}

function plainConfigPath(home?: string): string {
  return path.join(integrationsDir(home), `${PLAIN_INTEGRATION}.json`);
}

/**
 * Load + parse the Plain sidecar. Returns `undefined` when no file exists.
 * Throws `PlainConfigError` on a present-but-malformed file — a corrupt config
 * must surface, never be treated as "not configured".
 */
export async function loadPlainConfig(home?: string): Promise<PlainConfig | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(plainConfigPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PlainConfigError(`plain.json is not valid JSON: ${(err as Error).message}`);
  }
  const result = PlainConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new PlainConfigError(`plain.json failed validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Persist the Plain sidecar (non-secret — plain write). Merges `patch` over the
 * existing config (or defaults) so successive `symphony config plain` invocations
 * accumulate. `statuses` in the patch REPLACE the existing list (it's a small set
 * the user re-states, not a union). Returns the written config.
 */
export async function savePlainConfig(
  patch: Partial<PlainConfig>,
  home?: string,
): Promise<PlainConfig> {
  const existing = await loadPlainConfig(home);
  const merged = PlainConfigSchema.parse({
    ...(existing ?? {}),
    ...stripUndefined(patch),
  });
  const dir = integrationsDir(home);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(plainConfigPath(home), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

export class PlainConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlainConfigError';
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}
