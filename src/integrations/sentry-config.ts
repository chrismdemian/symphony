import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { integrationsDir } from './secrets.js';

/**
 * Phase 8D.5 — non-secret Sentry connector config (`~/.symphony/integrations/
 * sentry.json`). The auth token is NOT here — it lives in the OS keychain (or a
 * sibling 0o600 file) via `secrets.ts`.
 *
 * Sentry's REST API reads issues per project, so the connector activates only
 * when a token AND an `org` slug AND at least one `project` slug are configured:
 *   - `org`           — the Sentry organization slug (every endpoint is org-scoped).
 *   - `projects`      — the project slugs to pull unresolved issues from. UNIONed
 *                       across invocations (a second `--project` accumulates).
 *   - `baseUrl`       — the Sentry instance base (SaaS `https://sentry.io` default;
 *                       a region host like `https://us.sentry.io` or a self-hosted
 *                       URL otherwise). The client appends `/api/0`. MUST be https
 *                       (http allowed only for localhost) — the token rides this
 *                       host, so a non-TLS / arbitrary host is a leak surface.
 *   - `statusWriteback`— the NOTE text posted on the Sentry issue on completion /
 *                       failure. `completed` always posts a note (default text);
 *                       `failed` posts a note only when a template is configured
 *                       (Linear/Notion convention). A note NEVER changes status.
 *   - `resolveOnCompleted`— opt-in: ALSO mark the Sentry issue resolved on task
 *                       completion. Default `false` — a worker that INVESTIGATED an
 *                       error has not necessarily FIXED it, and auto-resolving an
 *                       unfixed error would hide a live production problem. Set
 *                       `--writeback-resolve` to enable. Failure never resolves.
 *
 * NOTE: this is NOT a Sentry DSN. A DSN is a write-only ingestion key (it lets an
 * SDK SEND events); reading issues for the trigger needs an auth token with the
 * `event:read` scope (+ `event:write` for the resolve writeback).
 */

export const SENTRY_INTEGRATION = 'sentry' as const;

/** Default SaaS base; the client appends `/api/0`. */
export const SENTRY_DEFAULT_BASE_URL = 'https://sentry.io';

/** Sentry org / project slugs: alnum start, then alnum + `.`, `_`, `-`. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const SentryConfigSchema = z.object({
  /** The Sentry organization slug. REQUIRED to activate. */
  org: z.string().regex(SLUG_RE, 'org must be a Sentry organization slug').optional(),
  /** Project slugs to pull unresolved issues from. At least one to activate. */
  projects: z
    .array(z.string().regex(SLUG_RE, 'each project must be a Sentry project slug'))
    .default([]),
  /**
   * Sentry instance base URL. Omit for SaaS (`https://sentry.io`). No trailing
   * slash required; the client normalizes it and appends `/api/0`. MUST be https
   * (http allowed only for localhost) — the token rides this URL, so a non-TLS /
   * arbitrary host is a leak surface.
   */
  baseUrl: z
    .string()
    .url()
    .refine(
      (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(u),
      'baseUrl must be https:// (http:// is allowed only for localhost)',
    )
    .optional(),
  /**
   * Symphony terminal status → Sentry issue NOTE text (writeback direction). A
   * note never changes the issue's status. `completed` always posts a note (a
   * default is used when omitted); `failed` posts a note only when configured.
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).optional(),
      failed: z.string().min(1).optional(),
    })
    .default({}),
  /**
   * Opt-in: ALSO mark the Sentry issue resolved when a task completes. Default
   * false (investigating ≠ fixing — auto-resolve could hide a live error). A
   * failed task never resolves regardless.
   */
  resolveOnCompleted: z.boolean().default(false),
});

export type SentryConfig = z.infer<typeof SentryConfigSchema>;

/** A fully-defaulted config (handy for tests + the token-only configure path). */
export function defaultSentryConfig(): SentryConfig {
  return SentryConfigSchema.parse({});
}

function sentryConfigPath(home?: string): string {
  return path.join(integrationsDir(home), `${SENTRY_INTEGRATION}.json`);
}

/**
 * Load + parse the Sentry sidecar. Returns `undefined` when no file exists.
 * Throws `SentryConfigError` on a present-but-malformed file — a corrupt config
 * must surface, never be treated as "not configured".
 */
export async function loadSentryConfig(home?: string): Promise<SentryConfig | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(sentryConfigPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SentryConfigError(`sentry.json is not valid JSON: ${(err as Error).message}`);
  }
  const result = SentryConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new SentryConfigError(`sentry.json failed validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Persist the Sentry sidecar (non-secret — plain write). Merges `patch` over the
 * existing config (or defaults) so successive `symphony config sentry`
 * invocations accumulate. `projects` in the patch are UNIONED with existing (a
 * second `--project` adds rather than replaces); pass `replaceProjects: true` to
 * set. Returns the written config.
 */
export async function saveSentryConfig(
  patch: Partial<SentryConfig> & { readonly replaceProjects?: boolean },
  home?: string,
): Promise<SentryConfig> {
  const existing = await loadSentryConfig(home);
  const { replaceProjects, ...rest } = patch;
  const mergedProjects =
    rest.projects === undefined
      ? (existing?.projects ?? [])
      : replaceProjects === true
        ? rest.projects
        : unionSlugs(existing?.projects ?? [], rest.projects);
  const merged = SentryConfigSchema.parse({
    ...(existing ?? {}),
    ...stripUndefined(rest),
    projects: mergedProjects,
  });
  const dir = integrationsDir(home);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(sentryConfigPath(home), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

export class SentryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SentryConfigError';
  }
}

/** Case-insensitive de-dup union preserving first-seen order. */
function unionSlugs(existing: readonly string[], added: readonly string[]): string[] {
  const seen = new Set(existing.map((r) => r.toLowerCase()));
  const out = [...existing];
  for (const r of added) {
    const key = r.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}
