import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

/**
 * github-source — the reference Symphony ISSUE-SOURCE plugin.
 *
 * It exposes the two tools the host's `PluginIssueConnectorAdapter` calls:
 *   - `fetch_open_issues({ limit? })` → `{ issues: NormalizedIssue[] }`
 *   - `write_back_status({ externalId, status })` → `IssueWritebackResult`
 * plus optional `search_issues` + `check_connection`. The host wraps these
 * into the SAME ingest + writeback pipeline the in-tree GitHub connector
 * uses (`sync_github`, `task_external_links`, terminal-status writeback) —
 * the plugin owns ONLY the GitHub I/O + its own secrets.
 *
 * GitHub logic is a compact, self-contained port of Symphony's in-tree
 * `github-client.ts` / `github.ts` (a plugin can't import app internals).
 * The PAT + repos come from `<install-dir>/config.json` (Symphony's env
 * allowlist strips every `SYMPHONY_*` var — plugins source their own
 * secrets, never Symphony's keychain). stdout is the MCP channel; all
 * diagnostics go to stderr.
 */

// ── config (read from the install dir; never from env) ───────────────────

interface GithubSourceConfig {
  readonly token: string;
  readonly repos: readonly string[];
  /** Override for GitHub Enterprise / a test mock. Default api.github.com. */
  readonly apiBaseUrl?: string;
  /** Comment posted on completion (default below). */
  readonly completedComment?: string;
  /** Comment posted on failure; when omitted, `failed` is a no-op. */
  readonly failedComment?: string;
  /** Max issues per fetch when the caller omits `limit`. */
  readonly fetchLimit?: number;
}

const ConfigSchema = z.object({
  token: z.string().min(1),
  repos: z.array(z.string().min(1)).min(1),
  apiBaseUrl: z.string().url().optional(),
  completedComment: z.string().optional(),
  failedComment: z.string().optional(),
  fetchLimit: z.number().int().min(1).max(500).optional(),
});

class ConfigError extends Error {}

function loadConfig(): GithubSourceConfig {
  const file = path.join(process.cwd(), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(
      `github-source is not configured — create ${file} with { "token": "...", "repos": ["owner/repo"] }`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
    throw new ConfigError(`config.json invalid${where}: ${first?.message ?? 'bad config'}`);
  }
  return parsed.data;
}

// ── GitHub REST (compact port of github-client.ts) ───────────────────────

const DEFAULT_API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const MAX_PER_PAGE = 100;
const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_COMPLETED_COMMENT = 'Completed by Symphony.';

interface RawIssue {
  id: number;
  number: number;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  html_url?: string | null;
  updated_at?: string | null;
  labels?: Array<{ name?: string | null } | string> | null;
  assignee?: { login?: string | null } | null;
  pull_request?: unknown;
  repository_url?: string | null;
}

/** The NormalizedIssue shape the host's adapter validates. */
interface NormalizedIssue {
  externalId: string;
  title: string;
  url: string | null;
  state: string | null;
  isTerminal: boolean;
  body: string | null;
  assignee: string | null;
  labels: string[];
  projectValue: string | null;
  priority: number;
  updatedAt: string | null;
}

interface WritebackResult {
  written: boolean;
  code: 'written' | 'skipped' | 'not-found' | 'error';
  value?: string;
  reason?: string;
}

class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function apiBase(cfg: GithubSourceConfig): string {
  return (cfg.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
}

function ghHeaders(cfg: GithubSourceConfig, extra?: Record<string, string>): Record<string, string> {
  return {
    authorization: `Bearer ${cfg.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    ...extra,
  };
}

async function ghFail(resp: Response, context: string): Promise<never> {
  const body = await resp.text().catch(() => '');
  const detail = body ? `: ${body.slice(0, 300)}` : '';
  throw new GitHubApiError(`GitHub ${resp.status} ${resp.statusText} on ${context}${detail}`, resp.status);
}

function labelsToPriority(labels: readonly string[]): number {
  let best = 0;
  for (const raw of labels) {
    const l = raw.toLowerCase();
    if (/(^|[\s:/-])(urgent|critical|p0|p1)([\s:/-]|$)/.test(l)) best = Math.max(best, 3);
    else if (/(^|[\s:/-])(high|p2)([\s:/-]|$)/.test(l)) best = Math.max(best, 2);
    else if (/(^|[\s:/-])(medium|p3)([\s:/-]|$)/.test(l)) best = Math.max(best, 1);
  }
  return best;
}

function mapIssue(raw: RawIssue, repo: string): NormalizedIssue {
  const labels = (raw.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
    .filter((n): n is string => n.length > 0);
  const title = (raw.title ?? '').trim();
  const state = raw.state ?? 'open';
  const htmlUrl = raw.html_url ?? '';
  const updatedAt = raw.updated_at ?? '';
  return {
    externalId: `${repo}#${raw.number}`,
    title: title.length > 0 ? title : `(untitled GitHub issue ${repo}#${raw.number})`,
    url: htmlUrl.length > 0 ? htmlUrl : null,
    state,
    isTerminal: state === 'closed',
    body: raw.body ?? null,
    assignee: raw.assignee?.login ?? null,
    labels,
    projectValue: repo.length > 0 ? repo : null,
    priority: labelsToPriority(labels),
    updatedAt: updatedAt.length > 0 ? updatedAt : null,
  };
}

function nextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return undefined;
}

async function listOpenIssues(
  cfg: GithubSourceConfig,
  repo: string,
  limit: number,
): Promise<NormalizedIssue[]> {
  const perPage = Math.min(limit, MAX_PER_PAGE);
  let url: string | undefined =
    `${apiBase(cfg)}/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=${perPage}`;
  const out: NormalizedIssue[] = [];
  while (url !== undefined && out.length < limit) {
    const resp = await fetch(url, { method: 'GET', headers: ghHeaders(cfg) });
    if (!resp.ok) await ghFail(resp, `list issues for ${repo}`);
    const raws = (await resp.json()) as RawIssue[];
    for (const raw of raws) {
      if (raw.pull_request !== undefined) continue; // issues endpoint returns PRs too
      out.push(mapIssue(raw, repo));
    }
    url = out.length < limit ? nextLink(resp.headers.get('link')) : undefined;
  }
  return out.slice(0, limit);
}

function repoFromUrl(repositoryUrl: string | null | undefined): string {
  if (!repositoryUrl) return '';
  const m = repositoryUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
  return m?.[1] ?? '';
}

async function searchIssues(
  cfg: GithubSourceConfig,
  term: string,
  limit: number,
): Promise<NormalizedIssue[]> {
  const perPage = Math.min(limit, MAX_PER_PAGE);
  const qualifiers = cfg.repos.map((r) => `repo:${r}`).join(' ');
  const q = `${term} is:issue is:open ${qualifiers}`.trim();
  const url = `${apiBase(cfg)}/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${perPage}`;
  const resp = await fetch(url, { method: 'GET', headers: ghHeaders(cfg) });
  if (!resp.ok) await ghFail(resp, 'search issues');
  const data = (await resp.json()) as { items?: RawIssue[] };
  const out: NormalizedIssue[] = [];
  for (const raw of data.items ?? []) {
    if (raw.pull_request !== undefined) continue;
    out.push(mapIssue(raw, repoFromUrl(raw.repository_url)));
  }
  return out.slice(0, limit);
}

async function addComment(cfg: GithubSourceConfig, repo: string, num: number, body: string): Promise<void> {
  const resp = await fetch(`${apiBase(cfg)}/repos/${repo}/issues/${num}/comments`, {
    method: 'POST',
    headers: ghHeaders(cfg, { 'content-type': 'application/json' }),
    body: JSON.stringify({ body }),
  });
  if (!resp.ok) await ghFail(resp, `comment on ${repo}#${num}`);
}

async function closeIssue(cfg: GithubSourceConfig, repo: string, num: number): Promise<void> {
  const resp = await fetch(`${apiBase(cfg)}/repos/${repo}/issues/${num}`, {
    method: 'PATCH',
    headers: ghHeaders(cfg, { 'content-type': 'application/json' }),
    body: JSON.stringify({ state: 'closed' }),
  });
  if (!resp.ok) await ghFail(resp, `close ${repo}#${num}`);
}

/** Split `owner/repo#number` → `{repo, number}`, or undefined when malformed. */
function parseExternalId(externalId: string): { repo: string; number: number } | undefined {
  const hash = externalId.lastIndexOf('#');
  if (hash <= 0 || hash === externalId.length - 1) return undefined;
  const repo = externalId.slice(0, hash);
  const numStr = externalId.slice(hash + 1);
  if (!repo.includes('/') || !/^[0-9]+$/.test(numStr)) return undefined;
  const num = Number(numStr);
  if (!Number.isInteger(num) || num <= 0) return undefined;
  return { repo, number: num };
}

async function fetchAllRepos(cfg: GithubSourceConfig, limit: number): Promise<NormalizedIssue[]> {
  const out: NormalizedIssue[] = [];
  let firstError: unknown;
  let failures = 0;
  for (const repo of cfg.repos) {
    try {
      out.push(...(await listOpenIssues(cfg, repo, limit)));
    } catch (err) {
      // One repo a token can't see must not abort the whole sync.
      failures += 1;
      if (firstError === undefined) firstError = err;
      process.stderr.write(`[github-source] ${repo}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (cfg.repos.length > 0 && failures === cfg.repos.length) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }
  return out;
}

async function writeBack(
  cfg: GithubSourceConfig,
  externalId: string,
  status: 'completed' | 'failed',
): Promise<WritebackResult> {
  const parsed = parseExternalId(externalId);
  if (parsed === undefined) {
    return { written: false, code: 'not-found', reason: `malformed GitHub id '${externalId}'` };
  }
  const { repo, number } = parsed;
  try {
    if (status === 'failed') {
      if (cfg.failedComment === undefined) {
        return { written: false, code: 'skipped', reason: "no 'failed' writeback configured" };
      }
      await addComment(cfg, repo, number, cfg.failedComment);
      return { written: true, code: 'written', value: 'commented (left open)' };
    }
    await addComment(cfg, repo, number, cfg.completedComment ?? DEFAULT_COMPLETED_COMMENT);
    await closeIssue(cfg, repo, number);
    return { written: true, code: 'written', value: 'commented + closed' };
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      return { written: false, code: 'not-found', reason: `GitHub issue ${repo}#${number} not found` };
    }
    return { written: false, code: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
}

// ── plugin ───────────────────────────────────────────────────────────────

await createPlugin({
  id: 'github-source-example',
  name: 'GitHub Issues source (example)',
  version: '0.1.0',
})
  .tool({
    name: 'fetch_open_issues',
    description: 'Return open GitHub issues across the configured repos as NormalizedIssue[] (issue-source contract).',
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe('Max issues to return (default per config).'),
    },
    handler: async ({ limit }) => {
      const cfg = loadConfig();
      const issues = await fetchAllRepos(cfg, limit ?? cfg.fetchLimit ?? DEFAULT_FETCH_LIMIT);
      return {
        text: `Fetched ${issues.length} open GitHub issue(s).`,
        structuredContent: { issues },
      };
    },
  })
  .tool({
    name: 'search_issues',
    description: 'Server-side search for open GitHub issues across the configured repos.',
    inputSchema: {
      term: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
    },
    handler: async ({ term, limit }) => {
      const cfg = loadConfig();
      const issues = await searchIssues(cfg, term, limit ?? cfg.fetchLimit ?? DEFAULT_FETCH_LIMIT);
      return { text: `Found ${issues.length} issue(s).`, structuredContent: { issues } };
    },
  })
  .tool({
    name: 'write_back_status',
    description: 'Push a terminal task status to a GitHub issue: completed → comment + close; failed → comment (if configured), never close.',
    inputSchema: {
      externalId: z.string().min(1).describe('owner/repo#number'),
      status: z.enum(['completed', 'failed']),
    },
    handler: async ({ externalId, status }) => {
      const cfg = loadConfig();
      const result = await writeBack(cfg, externalId, status);
      return {
        text: result.written ? `${externalId}: ${result.value}` : `${externalId}: ${result.code} (${result.reason ?? ''})`,
        structuredContent: { ...result },
      };
    },
  })
  .tool({
    name: 'check_connection',
    description: 'Verify the GitHub token by fetching the authenticated user.',
    handler: async () => {
      let cfg: GithubSourceConfig;
      try {
        cfg = loadConfig();
      } catch (err) {
        return { structuredContent: { ok: false, detail: err instanceof Error ? err.message : String(err) } };
      }
      try {
        const resp = await fetch(`${apiBase(cfg)}/user`, { method: 'GET', headers: ghHeaders(cfg) });
        if (!resp.ok) return { structuredContent: { ok: false, detail: `GitHub ${resp.status} ${resp.statusText}` } };
        const data = (await resp.json()) as { login?: string | null };
        return {
          structuredContent: data.login
            ? { ok: true, detail: `authenticated as ${data.login}` }
            : { ok: false, detail: 'authenticated, but no user returned' },
        };
      } catch (err) {
        return { structuredContent: { ok: false, detail: err instanceof Error ? err.message : String(err) } };
      }
    },
  })
  .serve();

// `serve()` resolves on connect (the stdio transport keeps the process
// alive), so this diagnostic line runs once the plugin is ready.
process.stderr.write('[github-source] serving — GitHub issue source for Symphony\n');
