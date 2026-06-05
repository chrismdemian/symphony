import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { integrationsDir } from './secrets.js';

/**
 * Phase 8C.2 — non-secret GitHub connector config (`~/.symphony/integrations/
 * github.json`). The personal-access token is NOT here — it lives in the OS
 * keychain (or a sibling 0o600 file) via `secrets.ts`.
 *
 * Unlike Linear (token-only activation), GitHub needs to know WHICH repos to
 * sync — the connector activates only when a token AND at least one `owner/repo`
 * are configured. Everything else is optional:
 *   - `repos`         — the `owner/repo` slugs to pull open issues from.
 *   - `apiBaseUrl`    — GitHub Enterprise Server API root (default api.github.com).
 *   - `statusWriteback`— the comment text posted on completion / failure.
 *     `completed` always comments (when a template is set) then CLOSES the issue;
 *     `failed` writeback only happens when a template is configured (Linear/Notion
 *     convention) and NEVER closes — a failed task leaves the issue open for a human.
 */

export const GITHUB_INTEGRATION = 'github' as const;

/** `owner/repo` — GitHub login + repo name segments (alnum, `.`, `-`, `_`). */
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const GitHubConfigSchema = z.object({
  /** `owner/repo` slugs to pull open issues from. At least one to activate. */
  repos: z
    .array(z.string().regex(REPO_SLUG_RE, 'each repo must be "owner/repo"'))
    .default([]),
  /**
   * GitHub Enterprise Server API root (e.g. `https://github.acme.com/api/v3`).
   * Omit for github.com (`https://api.github.com`). No trailing slash required;
   * the client normalizes it. MUST be https (http allowed only for localhost) —
   * the token rides this URL, so a non-TLS / arbitrary host is a leak surface.
   */
  apiBaseUrl: z
    .string()
    .url()
    .refine(
      (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(u),
      'apiBaseUrl must be https:// (http:// is allowed only for localhost)',
    )
    .optional(),
  /**
   * Symphony terminal status → GitHub issue comment text (writeback direction).
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

export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;

/** A fully-defaulted config (handy for tests + the token-only configure path). */
export function defaultGitHubConfig(): GitHubConfig {
  return GitHubConfigSchema.parse({});
}

function githubConfigPath(home?: string): string {
  return path.join(integrationsDir(home), `${GITHUB_INTEGRATION}.json`);
}

/**
 * Load + parse the GitHub sidecar. Returns `undefined` when no file exists.
 * Throws `GitHubConfigError` on a present-but-malformed file — a corrupt config
 * must surface, never be treated as "not configured".
 */
export async function loadGitHubConfig(home?: string): Promise<GitHubConfig | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(githubConfigPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GitHubConfigError(`github.json is not valid JSON: ${(err as Error).message}`);
  }
  const result = GitHubConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new GitHubConfigError(`github.json failed validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Persist the GitHub sidecar (non-secret — plain write). Merges `patch` over the
 * existing config (or defaults) so successive `symphony config github`
 * invocations accumulate. `repos` in the patch are UNIONED with existing (a
 * second `--repo` adds rather than replaces); pass `replaceRepos: true` to set.
 * Returns the written config.
 */
export async function saveGitHubConfig(
  patch: Partial<GitHubConfig> & { readonly replaceRepos?: boolean },
  home?: string,
): Promise<GitHubConfig> {
  const existing = await loadGitHubConfig(home);
  const { replaceRepos, ...rest } = patch;
  const mergedRepos =
    rest.repos === undefined
      ? (existing?.repos ?? [])
      : replaceRepos === true
        ? rest.repos
        : unionRepos(existing?.repos ?? [], rest.repos);
  const merged = GitHubConfigSchema.parse({
    ...(existing ?? {}),
    ...stripUndefined(rest),
    repos: mergedRepos,
  });
  const dir = integrationsDir(home);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(githubConfigPath(home), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

export class GitHubConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubConfigError';
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
