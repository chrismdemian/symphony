import { z } from 'zod';

/**
 * gitlab-source — a self-contained, raw-`fetch` port of Symphony's in-tree
 * GitLab connector (`src/integrations/gitlab.ts` + `gitlab-client.ts` +
 * `gitlab-config.ts`). A plugin can't import app internals, so the GitLab I/O +
 * the issue/priority mapping live here as plain, testable code; `index.ts` is
 * just config-load + tool registration.
 *
 * Auth: a GitLab **personal access token** in the `PRIVATE-TOKEN: <token>`
 * header (GitLab's PAT scheme — NOT `Authorization: Bearer`, which is OAuth).
 * The token is read from `<install-dir>/config.json`, never Symphony's keychain.
 *
 * id vs iid: a GitLab issue has BOTH a global `id` and a per-project `iid` (the
 * `#42` in the UI/URL). EVERY writeback path (`/issues/:iid`, notes, close) uses
 * `iid`, NEVER the global `id` — so the `externalId` is `group/project#iid`.
 *
 * Writeback moves the issue to closed (note + close on completion); a `failed`
 * task only gets a note (when configured) and is left open for a human.
 */

// ── config ───────────────────────────────────────────────────────────────

/**
 * `group/project` or `group/subgroup/project` — GitLab namespace path segments
 * (alnum plus `.`, `-`, `_`), at least one `/` (a project lives under a
 * namespace). The client URL-encodes each (`%2F`) as the `:id` ref directly.
 */
const PROJECT_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

export const GitLabSourceConfigSchema = z.object({
  /** GitLab personal access token (the `PRIVATE-TOKEN` header value). */
  token: z.string().min(1),
  /**
   * `group/project` paths to pull open issues from — AT LEAST ONE (the config IS
   * the activation for a plugin; GitLab needs to know which projects to pull).
   */
  projects: z
    .array(z.string().regex(PROJECT_PATH_RE, 'each project must be "group/project"'))
    .min(1, 'at least one "group/project" path is required'),
  /**
   * GitLab instance base URL (e.g. `https://gitlab.example.com`). Omit for
   * gitlab.com. MUST be https (http allowed only for localhost) — the
   * `PRIVATE-TOKEN` rides this URL, so a non-TLS / arbitrary host leaks it.
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
   * Symphony terminal status → GitLab issue note text (writeback). `completed`
   * posts the note (configured or default) then CLOSES the issue; `failed`
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

export type GitLabSourceConfig = z.infer<typeof GitLabSourceConfigSchema>;

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

// ── GitLab shapes ──────────────────────────────────────────────────────────

/** A GitLab issue, plus the `group/project` path it came from. */
export interface GitLabIssueNode {
  readonly projectPath: string;
  /** Global id (NOT used for writeback paths). */
  readonly id: number;
  /** Per-project issue number (`#42`) — the writeback path segment. */
  readonly iid: number;
  readonly title: string;
  readonly body: string | null;
  /** `opened` | `closed`. */
  readonly state: string;
  readonly webUrl: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
  readonly assignee: string | null;
}

export class GitLabApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GitLabApiError';
  }
}

interface RawIssue {
  id?: number | null;
  iid?: number | null;
  title?: string | null;
  description?: string | null;
  state?: string | null;
  web_url?: string | null;
  updated_at?: string | null;
  labels?: string[] | null;
  assignee?: { username?: string | null; name?: string | null } | null;
}

// ── pure mapping helpers (unit-tested directly) ───────────────────────────

/**
 * GitLab has no native priority — derive an integer (higher = sooner, default 0)
 * from conventional priority labels (incl. scoped `priority::high` form). Takes
 * the HIGHEST priority across all labels. Mirrors the Linear/GitHub scale
 * (urgent 3 / high 2 / medium 1 / low 0).
 */
export function gitlabLabelsToPriority(labels: readonly string[]): number {
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
 * Map a GitLab issue to a `NormalizedIssue`. `isTerminal` is `state === 'closed'`
 * so the host's ingest skips issues already closed in GitLab. The `externalId`
 * is `group/project#iid` (the per-project number), NOT the global id. Pure: no I/O.
 */
export function mapGitLabIssue(node: GitLabIssueNode): NormalizedIssue {
  const title = node.title.trim();
  return {
    externalId: `${node.projectPath}#${node.iid}`,
    title: title.length > 0 ? title : `(untitled GitLab issue ${node.projectPath}#${node.iid})`,
    url: node.webUrl.length > 0 ? node.webUrl : null,
    state: node.state,
    isTerminal: node.state === 'closed',
    body: node.body,
    assignee: node.assignee,
    labels: [...node.labels],
    // Route by the project path — a Symphony project named after it gets it.
    projectValue: node.projectPath.length > 0 ? node.projectPath : null,
    priority: gitlabLabelsToPriority(node.labels),
    updatedAt: node.updatedAt.length > 0 ? node.updatedAt : null,
  };
}

/**
 * Split `group/project#iid` → `{projectPath, iid}`, or undefined when malformed.
 * The project path may contain `/` (subgroups), so split on the LAST `#` (a path
 * segment can't contain `#`). Strict decimal `iid` (reject hex/exponent forms
 * `Number()` accepts).
 */
export function parseGitLabExternalId(
  externalId: string,
): { projectPath: string; iid: number } | undefined {
  const hash = externalId.lastIndexOf('#');
  if (hash <= 0 || hash === externalId.length - 1) return undefined;
  const projectPath = externalId.slice(0, hash);
  const iidStr = externalId.slice(hash + 1);
  if (!projectPath.includes('/') || !/^[0-9]+$/.test(iidStr)) return undefined;
  const iid = Number(iidStr);
  if (!Number.isInteger(iid) || iid <= 0) return undefined;
  return { projectPath, iid };
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

// ── the GitLab REST client + connector ─────────────────────────────────────

const DEFAULT_SITE_URL = 'https://gitlab.com';
const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_COMPLETED_NOTE = 'Completed by Symphony.';
/** GitLab caps `per_page` at 100. */
const MAX_PER_PAGE = 100;

interface EtagCacheEntry {
  readonly etag: string;
  readonly issues: readonly GitLabIssueNode[];
}

type FetchLike = typeof fetch;

/**
 * The GitLab issue source. Owns all GitLab I/O behind a serialized throttle.
 * `fetchImpl` is injectable so unit tests can drive it without a network. A
 * per-project ETag cache (single-page requests) makes a cheap repeated poll a
 * 304 — the same foundation as the in-tree connector.
 */
export class GitLabSource {
  private readonly throttle = new RequestThrottle(DEFAULT_MIN_GAP_MS);
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: string;
  private readonly etagCache = new Map<string, EtagCacheEntry>();

  constructor(
    private readonly config: GitLabSourceConfig,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.apiBase = `${(config.siteUrl ?? DEFAULT_SITE_URL).replace(/\/+$/, '')}/api/v4`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { 'private-token': this.config.token, accept: 'application/json', ...extra };
  }

  private encodeProject(projectPath: string): string {
    return encodeURIComponent(projectPath);
  }

  private async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      throw new GitLabApiError(
        `GitLab request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async fail(resp: Response, context: string): Promise<never> {
    const body = await resp.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 300)}` : '';
    if (resp.status === 401) {
      throw new GitLabApiError(`GitLab auth failed (401) on ${context}: check the token${detail}`, 401);
    }
    if (resp.status === 403) {
      throw new GitLabApiError(`GitLab forbidden (403) on ${context} (token scope?)${detail}`, 403);
    }
    if (resp.status === 404) {
      throw new GitLabApiError(
        `GitLab not found (404) on ${context}: project missing or no access${detail}`,
        404,
      );
    }
    throw new GitLabApiError(
      `GitLab API ${resp.status} ${resp.statusText} on ${context}${detail}`,
      resp.status,
    );
  }

  private mapRaw(raw: RawIssue, projectPath: string): GitLabIssueNode {
    return {
      projectPath,
      id: raw.id ?? 0,
      iid: raw.iid ?? 0,
      title: (raw.title ?? '').trim(),
      body: raw.description ?? null,
      state: raw.state ?? 'opened',
      webUrl: raw.web_url ?? '',
      updatedAt: raw.updated_at ?? '',
      labels: (raw.labels ?? []).filter((l): l is string => typeof l === 'string' && l.length > 0),
      assignee: raw.assignee?.username ?? raw.assignee?.name ?? null,
    };
  }

  /** Extract the `rel="next"` URL from a `Link` response header, if present. */
  private nextLink(linkHeader: string | null): string | undefined {
    if (!linkHeader) return undefined;
    for (const part of linkHeader.split(',')) {
      const m = part.match(/<([^>]+)>;\s*rel="next"/);
      if (m) return m[1];
    }
    return undefined;
  }

  /** Open issues for one `group/project`, newest-updated first (ETag-cached when single-page). */
  private async listProject(projectPath: string, limit: number): Promise<GitLabIssueNode[]> {
    const perPage = Math.min(limit, MAX_PER_PAGE);
    const firstUrl =
      `${this.apiBase}/projects/${this.encodeProject(projectPath)}/issues` +
      `?state=opened&order_by=updated_at&sort=desc&per_page=${perPage}`;

    // ETag conditional caching is only correct for SINGLE-PAGE requests: a 304 on
    // page 1 doesn't prove later pages are unchanged, and the cache is keyed by the
    // page-1 URL (which only varies `per_page`). For a multi-page request fetch
    // unconditionally and never touch the cache; for a single-page request
    // `per_page === limit`, so the URL key uniquely reflects the limit.
    const useCache = limit <= MAX_PER_PAGE;
    const cached = useCache ? this.etagCache.get(firstUrl) : undefined;
    const firstResp = await this.request(firstUrl, {
      method: 'GET',
      headers: this.headers(cached !== undefined ? { 'if-none-match': cached.etag } : undefined),
    });
    if (firstResp.status === 304 && cached !== undefined) {
      return cached.issues.slice(0, limit);
    }
    if (!firstResp.ok) await this.fail(firstResp, `list issues for ${projectPath}`);

    const collected: GitLabIssueNode[] = [];
    for (const raw of (await firstResp.json()) as RawIssue[]) collected.push(this.mapRaw(raw, projectPath));

    let next = collected.length < limit ? this.nextLink(firstResp.headers.get('link')) : undefined;
    while (next !== undefined && collected.length < limit) {
      const resp = await this.request(next, { method: 'GET', headers: this.headers() });
      if (!resp.ok) await this.fail(resp, `list issues for ${projectPath} (page)`);
      for (const raw of (await resp.json()) as RawIssue[]) collected.push(this.mapRaw(raw, projectPath));
      next = this.nextLink(resp.headers.get('link'));
    }

    const result = collected.slice(0, limit);
    if (useCache) {
      const etag = firstResp.headers.get('etag');
      if (etag) this.etagCache.set(firstUrl, { etag, issues: result });
    }
    return result;
  }

  /** Pull open + closed issues across the configured projects (the ingest skips closed). */
  async fetchOpenIssues(limit?: number): Promise<NormalizedIssue[]> {
    const cap = limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT;
    const out: NormalizedIssue[] = [];
    let firstError: unknown;
    let failures = 0;
    for (const project of this.config.projects) {
      try {
        const nodes = await this.throttle.run(() => this.listProject(project, cap));
        for (const n of nodes) out.push(mapGitLabIssue(n));
      } catch (err) {
        // A token that can't see one project (404/403) must not abort the whole
        // sync — skip + accumulate the first error, rethrow only if EVERY project
        // failed (so the tool surfaces a real failure, not a silent "0").
        failures += 1;
        if (firstError === undefined) firstError = err;
      }
    }
    if (this.config.projects.length > 0 && failures === this.config.projects.length) {
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
    return out;
  }

  /** Server-side search within each configured project (`search` over title+description). */
  async searchIssues(term: string, limit?: number): Promise<NormalizedIssue[]> {
    const cap = limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT;
    const out: NormalizedIssue[] = [];
    for (const project of this.config.projects) {
      try {
        const perPage = Math.min(cap, MAX_PER_PAGE);
        const url =
          `${this.apiBase}/projects/${this.encodeProject(project)}/issues` +
          `?search=${encodeURIComponent(term)}&in=title,description` +
          `&order_by=updated_at&sort=desc&per_page=${perPage}`;
        const nodes = await this.throttle.run(async () => {
          const resp = await this.request(url, { method: 'GET', headers: this.headers() });
          if (!resp.ok) await this.fail(resp, `search issues for ${project}`);
          return ((await resp.json()) as RawIssue[]).map((raw) => this.mapRaw(raw, project));
        });
        for (const n of nodes) out.push(mapGitLabIssue(n));
      } catch {
        // Skip a project we can't search; others still contribute.
      }
    }
    return out.slice(0, cap);
  }

  private async addNote(projectPath: string, iid: number, body: string): Promise<void> {
    const url = `${this.apiBase}/projects/${this.encodeProject(projectPath)}/issues/${iid}/notes`;
    const resp = await this.request(url, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ body }),
    });
    if (!resp.ok) await this.fail(resp, `note on ${projectPath}#${iid}`);
  }

  private async closeIssue(projectPath: string, iid: number): Promise<void> {
    const url = `${this.apiBase}/projects/${this.encodeProject(projectPath)}/issues/${iid}`;
    const resp = await this.request(url, {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ state_event: 'close' }),
    });
    if (!resp.ok) await this.fail(resp, `close ${projectPath}#${iid}`);
  }

  /**
   * Push a terminal task status to a GitLab issue: note (configured or default)
   * + close on completion; note-only (never close) on failure, and only when a
   * note is configured.
   */
  async writeBack(externalId: string, status: 'completed' | 'failed'): Promise<WritebackResult> {
    const parsed = parseGitLabExternalId(externalId);
    if (parsed === undefined) {
      return { written: false, code: 'not-found', reason: `malformed GitLab id '${externalId}'` };
    }
    const { projectPath, iid } = parsed;

    if (status === 'failed') {
      const note = this.config.statusWriteback.failed;
      if (note === undefined) {
        return { written: false, code: 'skipped', reason: "no 'failed' writeback configured" };
      }
      try {
        await this.throttle.run(() => this.addNote(projectPath, iid, note));
        return { written: true, code: 'written', value: 'noted (left open)' };
      } catch (err) {
        return this.writebackError(err, `${projectPath}#${iid}`);
      }
    }

    const note = this.config.statusWriteback.completed ?? DEFAULT_COMPLETED_NOTE;
    try {
      await this.throttle.run(() => this.addNote(projectPath, iid, note));
      await this.throttle.run(() => this.closeIssue(projectPath, iid));
      return { written: true, code: 'written', value: 'noted + closed' };
    } catch (err) {
      return this.writebackError(err, `${projectPath}#${iid}`);
    }
  }

  private writebackError(err: unknown, ref: string): WritebackResult {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof GitLabApiError && err.status === 404) {
      return { written: false, code: 'not-found', reason: `GitLab issue ${ref} not found` };
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
        const data = (await resp.json()) as { username?: string | null };
        return data.username
          ? { ok: true, detail: `authenticated as ${data.username}` }
          : { ok: false, detail: 'authenticated, but no user returned' };
      });
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
