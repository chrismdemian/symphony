import { z } from 'zod';

/**
 * forgejo-source — a self-contained, raw-`fetch` port of Symphony's in-tree
 * Forgejo (Gitea-compatible) connector (`src/integrations/forgejo.ts` +
 * `forgejo-client.ts` + `forgejo-config.ts`). A plugin can't import app
 * internals, so the Forgejo I/O + the issue/priority mapping live here as plain,
 * testable code; `index.ts` is just config-load + tool registration.
 *
 * Auth: a Forgejo **personal access token** in the `Authorization: token <token>`
 * header — the Gitea/Forgejo scheme, NOT `Authorization: Bearer` (that's OAuth).
 * The token is read from `<install-dir>/config.json`, never Symphony's keychain.
 *
 * Base URL: Forgejo is ALWAYS self-hosted, so `siteUrl` is REQUIRED (no default);
 * the client appends `/api/v1`. The issue index in every writeback path
 * (`/issues/:index`, comments, close) is the repo-scoped `number` (Gitea calls
 * it `index`), NEVER the global `id` — so the `externalId` is `owner/repo#number`.
 *
 * PR filtering: Gitea's issues endpoint returns pull requests too. We pass
 * `type=issues` (server-side) AND belt-and-suspenders skip any item with a
 * non-null `pull_request` field.
 */

// ── config ───────────────────────────────────────────────────────────────

/** `owner/repo` — Forgejo/Gitea owner + repo name segments (alnum, `.`, `-`, `_`). */
const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const ForgejoSourceConfigSchema = z.object({
  /** Forgejo personal access token (the `Authorization: token` header value). */
  token: z.string().min(1),
  /**
   * Forgejo instance base URL (e.g. `https://code.acme.com`). REQUIRED — Forgejo
   * is always self-hosted, no default. MUST be https (http allowed only for
   * localhost) — the token rides this URL, so a non-TLS / arbitrary host leaks it.
   */
  siteUrl: z
    .string()
    .url()
    .refine(
      (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(u),
      'siteUrl must be https:// (http:// is allowed only for localhost)',
    ),
  /**
   * `owner/repo` slugs to pull open issues from — AT LEAST ONE (the config IS the
   * activation for a plugin; Forgejo needs to know which repos to pull).
   */
  repos: z
    .array(z.string().regex(REPO_SLUG_RE, 'each repo must be "owner/repo"'))
    .min(1, 'at least one "owner/repo" is required'),
  /**
   * Symphony terminal status → Forgejo issue comment text (writeback). `completed`
   * posts the comment (configured or default) then CLOSES the issue; `failed`
   * writeback only fires when configured (omit to leave failed tasks' issues
   * untouched) and NEVER closes.
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).optional(),
      failed: z.string().min(1).optional(),
    })
    .default({}),
  /** Max issues per fetch when the caller omits `limit`. */
  fetchLimit: z.number().int().min(1).max(500).optional(),
});

export type ForgejoSourceConfig = z.infer<typeof ForgejoSourceConfigSchema>;

// ── the NormalizedIssue contract (validated host-side by the adapter) ─────

export interface NormalizedIssue {
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

export interface WritebackResult {
  written: boolean;
  code: 'written' | 'skipped' | 'not-found' | 'error';
  value?: string;
  reason?: string;
}

// ── Forgejo shapes ─────────────────────────────────────────────────────────

/** A Forgejo issue, plus the `owner/repo` it came from. */
export interface ForgejoIssueNode {
  readonly repo: string;
  /** Global id (NOT used for writeback paths). */
  readonly id: number;
  /** Per-repo issue number / index (`#42`) — the writeback path segment. */
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  /** `open` | `closed`. */
  readonly state: string;
  readonly htmlUrl: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
  readonly assignee: string | null;
}

export class ForgejoApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ForgejoApiError';
  }
}

interface RawIssue {
  id?: number | null;
  number?: number | null;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  html_url?: string | null;
  updated_at?: string | null;
  labels?: Array<{ name?: string | null } | string> | null;
  assignee?: { login?: string | null; full_name?: string | null } | null;
  /** Non-null means this "issue" is actually a pull request — filter it out. */
  pull_request?: unknown;
}

// ── pure mapping helpers (unit-tested directly) ───────────────────────────

/**
 * Forgejo has no native priority — derive an integer (higher = sooner, default 0)
 * from conventional priority labels (incl. scoped `priority/high` form). Takes
 * the HIGHEST priority across all labels. Mirrors the Linear/GitHub/GitLab scale
 * (urgent 3 / high 2 / medium 1 / low 0).
 */
export function forgejoLabelsToPriority(labels: readonly string[]): number {
  let best = 0;
  for (const raw of labels) {
    const l = raw.toLowerCase();
    if (/(^|[\s:/-])(urgent|critical|p0|p1)([\s:/-]|$)/.test(l)) best = Math.max(best, 3);
    else if (/(^|[\s:/-])(high|p2)([\s:/-]|$)/.test(l)) best = Math.max(best, 2);
    else if (/(^|[\s:/-])(medium|p3)([\s:/-]|$)/.test(l)) best = Math.max(best, 1);
    // `low`/`p4` map to 0 — already the floor; nothing to bump.
  }
  return best;
}

/**
 * Map a Forgejo issue to a `NormalizedIssue`. `isTerminal` is `state === 'closed'`
 * so the host's ingest skips issues already closed in Forgejo. The `externalId`
 * is `owner/repo#number` (the per-repo number), NOT the global id. Pure: no I/O.
 */
export function mapForgejoIssue(node: ForgejoIssueNode): NormalizedIssue {
  const title = node.title.trim();
  return {
    externalId: `${node.repo}#${node.number}`,
    title: title.length > 0 ? title : `(untitled Forgejo issue ${node.repo}#${node.number})`,
    url: node.htmlUrl.length > 0 ? node.htmlUrl : null,
    state: node.state,
    isTerminal: node.state === 'closed',
    body: node.body,
    assignee: node.assignee,
    labels: [...node.labels],
    // Route by the repo slug — a Symphony project named after the repo gets it.
    projectValue: node.repo.length > 0 ? node.repo : null,
    priority: forgejoLabelsToPriority(node.labels),
    updatedAt: node.updatedAt.length > 0 ? node.updatedAt : null,
  };
}

/** Split `owner/repo#number` → `{repo, number}`, or undefined when malformed. */
export function parseForgejoExternalId(
  externalId: string,
): { repo: string; number: number } | undefined {
  const hash = externalId.lastIndexOf('#');
  if (hash <= 0 || hash === externalId.length - 1) return undefined;
  const repo = externalId.slice(0, hash);
  const numStr = externalId.slice(hash + 1);
  if (!repo.includes('/') || !/^[0-9]+$/.test(numStr)) return undefined;
  const num = Number(numStr);
  if (!Number.isInteger(num) || num <= 0) return undefined;
  return { repo, number: num };
}

// ── serialized request throttle (8A parity — no overlapping HTTP) ─────────

class RequestThrottle {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly minGapMs: number) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const elapsed = Date.now() - this.last;
      const wait = this.minGapMs - elapsed;
      if (wait > 0) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, wait);
          // Don't keep the event loop alive solely for a throttle gap.
          if (typeof t.unref === 'function') t.unref();
        });
      }
      this.last = Date.now();
      return fn();
    });
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// ── the Forgejo REST client + connector ─────────────────────────────────────

const API_PREFIX = '/api/v1';
const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_COMPLETED_COMMENT = 'Completed by Symphony.';
/** Gitea/Forgejo default `limit` cap per page is 50. */
const MAX_PER_PAGE = 50;

interface EtagCacheEntry {
  readonly etag: string;
  readonly issues: readonly ForgejoIssueNode[];
}

type FetchLike = typeof fetch;

/**
 * The Forgejo issue source. Owns all Forgejo I/O behind a serialized throttle.
 * `fetchImpl` is injectable so unit tests can drive it without a network. A
 * per-repo ETag cache (single-page requests) makes a cheap repeated poll a 304 —
 * the same foundation as the in-tree connector.
 */
export class ForgejoSource {
  private readonly throttle = new RequestThrottle(DEFAULT_MIN_GAP_MS);
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: string;
  private readonly etagCache = new Map<string, EtagCacheEntry>();

  constructor(
    private readonly config: ForgejoSourceConfig,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.apiBase = `${config.siteUrl.replace(/\/+$/, '')}${API_PREFIX}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `token ${this.config.token}`, accept: 'application/json', ...extra };
  }

  private async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      throw new ForgejoApiError(
        `Forgejo request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async fail(resp: Response, context: string): Promise<never> {
    const body = await resp.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 300)}` : '';
    if (resp.status === 401) {
      throw new ForgejoApiError(`Forgejo auth failed (401) on ${context}: check the token${detail}`, 401);
    }
    if (resp.status === 403) {
      throw new ForgejoApiError(`Forgejo forbidden (403) on ${context} (token scope?)${detail}`, 403);
    }
    if (resp.status === 404) {
      throw new ForgejoApiError(
        `Forgejo not found (404) on ${context}: repo missing or no access${detail}`,
        404,
      );
    }
    throw new ForgejoApiError(
      `Forgejo API ${resp.status} ${resp.statusText} on ${context}${detail}`,
      resp.status,
    );
  }

  private mapRaw(raw: RawIssue, repo: string): ForgejoIssueNode {
    return {
      repo,
      id: raw.id ?? 0,
      number: raw.number ?? 0,
      title: (raw.title ?? '').trim(),
      body: raw.body ?? null,
      state: raw.state ?? 'open',
      htmlUrl: raw.html_url ?? '',
      updatedAt: raw.updated_at ?? '',
      labels: (raw.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
        .filter((n): n is string => n.length > 0),
      assignee: raw.assignee?.login ?? raw.assignee?.full_name ?? null,
    };
  }

  /** Push only real issues (Gitea returns PRs too — `pull_request` is non-null for those). */
  private pushPage(collected: ForgejoIssueNode[], raws: RawIssue[], repo: string): void {
    for (const raw of raws) {
      if (raw.pull_request !== undefined && raw.pull_request !== null) continue;
      collected.push(this.mapRaw(raw, repo));
    }
  }

  /** Open issues for one `owner/repo`, newest-updated first, PRs excluded. */
  private async listRepo(repo: string, limit: number): Promise<ForgejoIssueNode[]> {
    const perPage = Math.min(limit, MAX_PER_PAGE);
    const listUrl = (page: number): string =>
      `${this.apiBase}/repos/${repo}/issues` +
      `?state=open&type=issues&sort=recentupdate&page=${page}&limit=${perPage}`;
    const firstUrl = listUrl(1);

    // ETag conditional caching is only correct for SINGLE-PAGE requests: a 304 on
    // page 1 doesn't prove later pages are unchanged, and the cache is keyed by the
    // page-1 URL (which only varies `limit`). For a multi-page request fetch
    // unconditionally and never touch the cache; for a single-page request
    // `perPage === limit`, so the URL key uniquely reflects the limit.
    const useCache = limit <= MAX_PER_PAGE;
    const cached = useCache ? this.etagCache.get(firstUrl) : undefined;
    const firstResp = await this.request(firstUrl, {
      method: 'GET',
      headers: this.headers(cached !== undefined ? { 'if-none-match': cached.etag } : undefined),
    });
    if (firstResp.status === 304 && cached !== undefined) {
      return cached.issues.slice(0, limit);
    }
    if (!firstResp.ok) await this.fail(firstResp, `list issues for ${repo}`);

    const collected: ForgejoIssueNode[] = [];
    const firstRaws = (await firstResp.json()) as RawIssue[];
    this.pushPage(collected, firstRaws, repo);

    // Page-based pagination: keep fetching while the last page was full AND we
    // still need more. A short page means we hit the end.
    let page = 1;
    let lastPageLen = firstRaws.length;
    while (lastPageLen === perPage && collected.length < limit) {
      page += 1;
      const resp = await this.request(listUrl(page), { method: 'GET', headers: this.headers() });
      if (!resp.ok) await this.fail(resp, `list issues for ${repo} (page ${page})`);
      const raws = (await resp.json()) as RawIssue[];
      this.pushPage(collected, raws, repo);
      lastPageLen = raws.length;
    }

    const result = collected.slice(0, limit);
    if (useCache) {
      const etag = firstResp.headers.get('etag');
      if (etag) this.etagCache.set(firstUrl, { etag, issues: result });
    }
    return result;
  }

  /** Pull open + closed issues across the configured repos (the ingest skips closed). */
  async fetchOpenIssues(limit?: number): Promise<NormalizedIssue[]> {
    const cap = limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT;
    const out: NormalizedIssue[] = [];
    let firstError: unknown;
    let failures = 0;
    for (const repo of this.config.repos) {
      try {
        const nodes = await this.throttle.run(() => this.listRepo(repo, cap));
        for (const n of nodes) out.push(mapForgejoIssue(n));
      } catch (err) {
        // A token that can't see one repo (404/403) must not abort the whole sync
        // — skip + accumulate the first error, rethrow only if EVERY repo failed.
        failures += 1;
        if (firstError === undefined) firstError = err;
      }
    }
    if (this.config.repos.length > 0 && failures === this.config.repos.length) {
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
    return out;
  }

  /** Server-side search within each configured repo (`q` over title/body). */
  async searchIssues(term: string, limit?: number): Promise<NormalizedIssue[]> {
    const cap = limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT;
    const out: NormalizedIssue[] = [];
    for (const repo of this.config.repos) {
      try {
        const perPage = Math.min(cap, MAX_PER_PAGE);
        const url =
          `${this.apiBase}/repos/${repo}/issues` +
          `?state=open&type=issues&q=${encodeURIComponent(term)}&page=1&limit=${perPage}`;
        const nodes = await this.throttle.run(async () => {
          const resp = await this.request(url, { method: 'GET', headers: this.headers() });
          if (!resp.ok) await this.fail(resp, `search issues for ${repo}`);
          const collected: ForgejoIssueNode[] = [];
          this.pushPage(collected, (await resp.json()) as RawIssue[], repo);
          return collected;
        });
        for (const n of nodes) out.push(mapForgejoIssue(n));
      } catch {
        // Skip a repo we can't search; others still contribute.
      }
    }
    return out.slice(0, cap);
  }

  private async addComment(repo: string, issueNumber: number, body: string): Promise<void> {
    const url = `${this.apiBase}/repos/${repo}/issues/${issueNumber}/comments`;
    const resp = await this.request(url, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ body }),
    });
    if (!resp.ok) await this.fail(resp, `comment on ${repo}#${issueNumber}`);
  }

  private async closeIssue(repo: string, issueNumber: number): Promise<void> {
    const url = `${this.apiBase}/repos/${repo}/issues/${issueNumber}`;
    const resp = await this.request(url, {
      method: 'PATCH',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ state: 'closed' }),
    });
    if (!resp.ok) await this.fail(resp, `close ${repo}#${issueNumber}`);
  }

  /**
   * Push a terminal task status to a Forgejo issue: comment (configured or
   * default) + close on completion; comment-only (never close) on failure, and
   * only when a comment is configured.
   */
  async writeBack(externalId: string, status: 'completed' | 'failed'): Promise<WritebackResult> {
    const parsed = parseForgejoExternalId(externalId);
    if (parsed === undefined) {
      return { written: false, code: 'not-found', reason: `malformed Forgejo id '${externalId}'` };
    }
    const { repo, number } = parsed;

    if (status === 'failed') {
      const comment = this.config.statusWriteback.failed;
      if (comment === undefined) {
        return { written: false, code: 'skipped', reason: "no 'failed' writeback configured" };
      }
      try {
        await this.throttle.run(() => this.addComment(repo, number, comment));
        return { written: true, code: 'written', value: 'commented (left open)' };
      } catch (err) {
        return this.writebackError(err, `${repo}#${number}`);
      }
    }

    const comment = this.config.statusWriteback.completed ?? DEFAULT_COMPLETED_COMMENT;
    try {
      await this.throttle.run(() => this.addComment(repo, number, comment));
      await this.throttle.run(() => this.closeIssue(repo, number));
      return { written: true, code: 'written', value: 'commented + closed' };
    } catch (err) {
      return this.writebackError(err, `${repo}#${number}`);
    }
  }

  private writebackError(err: unknown, ref: string): WritebackResult {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof ForgejoApiError && err.status === 404) {
      return { written: false, code: 'not-found', reason: `Forgejo issue ${ref} not found` };
    }
    return { written: false, code: 'error', reason };
  }

  /** Verify the token by fetching the authenticated user. */
  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    try {
      return await this.throttle.run(async () => {
        const resp = await this.request(`${this.apiBase}/user`, {
          method: 'GET',
          headers: this.headers(),
        });
        if (!resp.ok) await this.fail(resp, 'get authenticated user');
        const data = (await resp.json()) as { login?: string | null };
        return data.login
          ? { ok: true, detail: `authenticated as ${data.login}` }
          : { ok: false, detail: 'authenticated, but no user returned' };
      });
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
