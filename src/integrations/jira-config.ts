import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { integrationsDir } from './secrets.js';

/**
 * Phase 8C.3 — non-secret Jira connector config (`~/.symphony/integrations/
 * jira.json`). The API token is NOT here — it lives in the OS keychain (or a
 * sibling 0o600 file) via `secrets.ts`.
 *
 * Jira Cloud authenticates with HTTP Basic `email:apiToken`, so BOTH the
 * `siteUrl` and the `email` are required to activate (alongside the keychain
 * token). Everything else is optional:
 *   - `siteUrl`      — the Jira base (e.g. `https://acme.atlassian.net`). MUST be
 *     https (the token rides this host). REST v3 paths are appended to it.
 *   - `email`        — the Atlassian account email (the Basic-auth username).
 *   - `projectKeys`  — optional project keys (e.g. `ENG`, `OPS`) to lead the JQL
 *     fetch with. Omit to rely on the assignee/reporter fallback chain.
 *   - `statusWriteback`— `completed`/`failed` comment text + an optional
 *     `completedTransition` name override. On completion Symphony posts the
 *     comment then transitions the issue to a Done-category state (the override
 *     name wins; otherwise the first `done`-category transition is used).
 *     `failed` writeback only fires when a comment is configured and NEVER
 *     transitions — a failed task leaves the issue where it is for a human.
 */

export const JIRA_INTEGRATION = 'jira' as const;

/** A Jira project key: leading letter, then letters/digits/underscore (e.g. `ENG`, `AB12`). */
const PROJECT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export const JiraConfigSchema = z.object({
  /** Jira base URL (e.g. `https://acme.atlassian.net`). https-only. Required to activate. */
  siteUrl: z
    .string()
    .url()
    .refine(
      (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(u),
      'siteUrl must be https:// (http:// is allowed only for localhost)',
    )
    .optional(),
  /** Atlassian account email — the Basic-auth username. Required to activate. */
  email: z.string().email().optional(),
  /** Optional project keys to lead the JQL fetch with (e.g. ["ENG", "OPS"]). */
  projectKeys: z
    .array(z.string().regex(PROJECT_KEY_RE, 'each project key must look like "ENG"'))
    .default([]),
  /**
   * Symphony terminal status → Jira issue writeback. `completed` posts the
   * comment (when set, default otherwise) then transitions the issue to a
   * Done-category state; `completedTransition` overrides which transition by
   * name. `failed` posts a comment ONLY when configured and never transitions.
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).optional(),
      failed: z.string().min(1).optional(),
      completedTransition: z.string().min(1).optional(),
    })
    .default({}),
});

export type JiraConfig = z.infer<typeof JiraConfigSchema>;

/** A fully-defaulted config (handy for tests + the token-only configure path). */
export function defaultJiraConfig(): JiraConfig {
  return JiraConfigSchema.parse({});
}

function jiraConfigPath(home?: string): string {
  return path.join(integrationsDir(home), `${JIRA_INTEGRATION}.json`);
}

/**
 * Load + parse the Jira sidecar. Returns `undefined` when no file exists.
 * Throws `JiraConfigError` on a present-but-malformed file — a corrupt config
 * must surface, never be treated as "not configured".
 */
export async function loadJiraConfig(home?: string): Promise<JiraConfig | undefined> {
  let raw: string;
  try {
    raw = await fsp.readFile(jiraConfigPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new JiraConfigError(`jira.json is not valid JSON: ${(err as Error).message}`);
  }
  const result = JiraConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new JiraConfigError(`jira.json failed validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Persist the Jira sidecar (non-secret — plain write). Merges `patch` over the
 * existing config (or defaults) so successive `symphony config jira` invocations
 * accumulate. `projectKeys` in the patch are UNIONED with existing (a second
 * `--project` adds rather than replaces); pass `replaceProjectKeys: true` to set.
 * Returns the written config.
 */
export async function saveJiraConfig(
  patch: Partial<JiraConfig> & { readonly replaceProjectKeys?: boolean },
  home?: string,
): Promise<JiraConfig> {
  const existing = await loadJiraConfig(home);
  const { replaceProjectKeys, ...rest } = patch;
  const mergedKeys =
    rest.projectKeys === undefined
      ? (existing?.projectKeys ?? [])
      : replaceProjectKeys === true
        ? rest.projectKeys
        : unionKeys(existing?.projectKeys ?? [], rest.projectKeys);
  const merged = JiraConfigSchema.parse({
    ...(existing ?? {}),
    ...stripUndefined(rest),
    projectKeys: mergedKeys,
  });
  const dir = integrationsDir(home);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(jiraConfigPath(home), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return merged;
}

export class JiraConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JiraConfigError';
  }
}

/** Case-insensitive de-dup union preserving first-seen order. */
function unionKeys(existing: readonly string[], added: readonly string[]): string[] {
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
