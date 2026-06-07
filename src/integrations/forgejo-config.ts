import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { integrationsDir } from './secrets.js';

/**
 * Phase 8C.4 — non-secret Forgejo connector config (`~/.symphony/integrations/
 * forgejo.json`). The personal-access token is NOT here — it lives in the OS
 * keychain (or a sibling 0o600 file) via `secrets.ts`.
 *
 * Forgejo is a Gitea fork with a Gitea-compatible REST API. Unlike GitHub
 * (api.github.com) it is ALWAYS self-hosted, so `siteUrl` is required to
 * activate alongside a token and at least one `owner/repo`:
 *   - `repos`         — the `owner/repo` slugs to pull open issues from.
 *   - `siteUrl`       — the Forgejo instance base (e.g. `https://code.acme.com`).
 *     No default (self-hosted). MUST be https (http allowed only for localhost) —
 *     the token rides this host, so a non-TLS / arbitrary host leaks it. The
 *     client appends `/api/v1`.
 *   - `statusWriteback`— the comment text posted on completion / failure.
 *     `completed` always comments (when a template is set) then CLOSES the issue;
 *     `failed` writeback only happens when a template is configured (Linear/Notion
 *     convention) and NEVER closes — a failed task leaves the issue open for a human.
 */

export const FORGEJO_INTEGRATION = 'forgejo' as const;

/** `owner/repo` — Forgejo/Gitea owner + repo name segments (alnum, `.`, `-`, `_`). */
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const ForgejoConfigSchema = z.object({
  /** `owner/repo` slugs to pull open issues from. At least one to activate. */
  repos: z
    .array(z.string().regex(REPO_SLUG_RE, 'each repo must be "owner/repo"'))
    .default([]),
  /**
   * Forgejo instance base URL (e.g. `https://code.acme.com`). REQUIRED to
   * activate — Forgejo is always self-hosted, so there is no default. No trailing
   * slash required; the client normalizes it and appends `/api/v1`. MUST be https
   * (http allowed only for localhost) — the token rides this URL, so a non-TLS /
   * arbitrary host is a leak surface.
   */
  siteUrl: z
    .string()
    .url()
    .refine(
      (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(u),
      'siteUrl must be https:// (http:// is allowed only for localhost)',
    )
    .optional(),
  /**
   * Symphony terminal status → Forgejo issue comment text (writeback direction).
   * `completed` posts the comment (when set) then closes the issue; a default
   * completion comment is used when omitted. `failed` writeback only fires when
   * configured (omit to leave failed tasks' issues untouched), and never closes.
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).optional(),
      failed: z.string().min(1).optional(),
    })
    .default({}),
});

export type ForgejoConfig = z.infer<typeof ForgejoConfigSchema>;

/** A fully-defaulted config (handy for tests + the token-only configure path). */
export function defaultForgejoConfig(): ForgejoConfig {
  return ForgejoConfigSchema.parse({});
}

function forgejoConfigPath(home?: string): string {
  return path.join(integrationsDir(home), `${FORGEJO_INTEGRATION}.json`);
}

/**
 * Load + parse the Forgejo sidecar. Returns `undefined` when no file exists.
 * Throws `ForgejoConfigError` on a present-but-malformed file — a corrupt config
 * must surface, never be treated as "not configured".
 */
export async function loadForgejoConfig(home?: string): Promise<ForgejoConfig | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(forgejoConfigPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ForgejoConfigError(`forgejo.json is not valid JSON: ${(err as Error).message}`);
  }
  const result = ForgejoConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ForgejoConfigError(`forgejo.json failed validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Persist the Forgejo sidecar (non-secret — plain write). Merges `patch` over the
 * existing config (or defaults) so successive `symphony config forgejo`
 * invocations accumulate. `repos` in the patch are UNIONED with existing (a
 * second `--repo` adds rather than replaces); pass `replaceRepos: true` to set.
 * Returns the written config.
 */
export async function saveForgejoConfig(
  patch: Partial<ForgejoConfig> & { readonly replaceRepos?: boolean },
  home?: string,
): Promise<ForgejoConfig> {
  const existing = await loadForgejoConfig(home);
  const { replaceRepos, ...rest } = patch;
  const mergedRepos =
    rest.repos === undefined
      ? (existing?.repos ?? [])
      : replaceRepos === true
        ? rest.repos
        : unionRepos(existing?.repos ?? [], rest.repos);
  const merged = ForgejoConfigSchema.parse({
    ...(existing ?? {}),
    ...stripUndefined(rest),
    repos: mergedRepos,
  });
  const dir = integrationsDir(home);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(forgejoConfigPath(home), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

export class ForgejoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgejoConfigError';
  }
}

/** Case-insensitive de-dup union preserving first-seen order. */
function unionRepos(existing: readonly string[], added: readonly string[]): string[] {
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
