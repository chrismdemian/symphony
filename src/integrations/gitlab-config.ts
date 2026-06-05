import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { integrationsDir } from './secrets.js';

/**
 * Phase 8C.3 — non-secret GitLab connector config (`~/.symphony/integrations/
 * gitlab.json`). The personal-access token is NOT here — it lives in the OS
 * keychain (or a sibling 0o600 file) via `secrets.ts`.
 *
 * Like GitHub (and unlike token-only Linear), GitLab needs to know WHICH
 * projects to sync — the connector activates only when a token AND at least one
 * `group/project` path are configured. Everything else is optional:
 *   - `projects`     — `group/project` (or `group/subgroup/project`) paths to
 *     pull open issues from. The client URL-encodes each (`%2F`) and uses it as
 *     the project ref directly (no numeric-id resolve step).
 *   - `siteUrl`      — the GitLab instance base (default `https://gitlab.com`;
 *     set for self-hosted). MUST be https (http allowed only for localhost) —
 *     the `PRIVATE-TOKEN` rides this host, so a non-TLS / arbitrary host leaks it.
 *   - `statusWriteback`— the note text posted on completion / failure.
 *     `completed` always posts the note (when set) then CLOSES the issue;
 *     `failed` writeback only happens when a template is configured (Linear/Notion
 *     convention) and NEVER closes — a failed task leaves the issue open for a human.
 */

export const GITLAB_INTEGRATION = 'gitlab' as const;

/**
 * `group/project` or `group/subgroup/project` — GitLab namespace path segments.
 * Each segment is alnum plus `.`, `-`, `_` (GitLab also allows a few others but
 * this covers the common case and keeps the path safe to URL-encode). At least
 * one `/` (a project always lives under a namespace).
 */
const PROJECT_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

export const GitLabConfigSchema = z.object({
  /** `group/project` paths to pull open issues from. At least one to activate. */
  projects: z
    .array(z.string().regex(PROJECT_PATH_RE, 'each project must be "group/project"'))
    .default([]),
  /**
   * GitLab instance base URL (e.g. `https://gitlab.example.com`). Omit for
   * gitlab.com (`https://gitlab.com`). No trailing slash required; the client
   * normalizes it. MUST be https (http allowed only for localhost) — the
   * `PRIVATE-TOKEN` rides this URL, so a non-TLS / arbitrary host is a leak surface.
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
   * Symphony terminal status → GitLab issue note text (writeback direction).
   * `completed` posts the note (when set) then closes the issue; a default
   * completion note is used when omitted. `failed` writeback only fires when
   * configured (omit to leave failed tasks' issues untouched), and never closes.
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).optional(),
      failed: z.string().min(1).optional(),
    })
    .default({}),
});

export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;

/** A fully-defaulted config (handy for tests + the token-only configure path). */
export function defaultGitLabConfig(): GitLabConfig {
  return GitLabConfigSchema.parse({});
}

function gitlabConfigPath(home?: string): string {
  return path.join(integrationsDir(home), `${GITLAB_INTEGRATION}.json`);
}

/**
 * Load + parse the GitLab sidecar. Returns `undefined` when no file exists.
 * Throws `GitLabConfigError` on a present-but-malformed file — a corrupt config
 * must surface, never be treated as "not configured".
 */
export async function loadGitLabConfig(home?: string): Promise<GitLabConfig | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(gitlabConfigPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GitLabConfigError(`gitlab.json is not valid JSON: ${(err as Error).message}`);
  }
  const result = GitLabConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new GitLabConfigError(`gitlab.json failed validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Persist the GitLab sidecar (non-secret — plain write). Merges `patch` over the
 * existing config (or defaults) so successive `symphony config gitlab`
 * invocations accumulate. `projects` in the patch are UNIONED with existing (a
 * second `--project` adds rather than replaces); pass `replaceProjects: true` to set.
 * Returns the written config.
 */
export async function saveGitLabConfig(
  patch: Partial<GitLabConfig> & { readonly replaceProjects?: boolean },
  home?: string,
): Promise<GitLabConfig> {
  const existing = await loadGitLabConfig(home);
  const { replaceProjects, ...rest } = patch;
  const mergedProjects =
    rest.projects === undefined
      ? (existing?.projects ?? [])
      : replaceProjects === true
        ? rest.projects
        : unionProjects(existing?.projects ?? [], rest.projects);
  const merged = GitLabConfigSchema.parse({
    ...(existing ?? {}),
    ...stripUndefined(rest),
    projects: mergedProjects,
  });
  const dir = integrationsDir(home);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(gitlabConfigPath(home), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

export class GitLabConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitLabConfigError';
  }
}

/** Case-insensitive de-dup union preserving first-seen order. */
function unionProjects(existing: readonly string[], added: readonly string[]): string[] {
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
