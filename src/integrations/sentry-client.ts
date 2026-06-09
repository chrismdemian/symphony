/**
 * Phase 8D.5 — narrow Sentry REST (`/api/0`) client seam.
 *
 * Mirrors `github-client.ts` / `forgejo-client.ts`: the connector talks to this
 * interface, never the raw API, so unit tests substitute a hand-written fake
 * without any network. The real impl is a thin REST layer over global `fetch`.
 *
 * Auth: a Sentry **auth token** (user auth token, internal-integration token, or
 * org auth token) in the `Authorization: Bearer <token>` header. Reading issues
 * needs the `event:read` scope; the opt-in resolve writeback needs `event:write`.
 * (A Sentry DSN is NOT a token — it's a write-only ingestion key.)
 *
 * Base URL: SaaS `https://sentry.io` by default; a region host
 * (`https://us.sentry.io`) or a self-hosted instance otherwise. The client
 * appends `/api/0`.
 *
 * Pagination: cursor-based via the `Link` response header. Sentry tags each link
 * with `results="true|false"`; we follow `rel="next"` ONLY while `results="true"`.
 *
 * Endpoints used:
 *   - list:   GET  /projects/{org}/{project}/issues/?query=is:unresolved&sort=new
 *   - search: GET  /projects/{org}/{project}/issues/?query=is:unresolved <term>
 *   - note:   POST /issues/{issueId}/notes/            { text }
 *   - resolve:PUT  /organizations/{org}/issues/{issueId}/  { status: "resolved" }
 */

const API_PREFIX = '/api/0';
/** Sentry caps issue list pages at 100. */
const MAX_PER_PAGE = 100;

/** A raw Sentry issue (error group), plus the project slug it came from (always
 *  populated by the client so the connector can form a stable `<project>#<id>`
 *  external id — the numeric group id is what every writeback path needs). */
export interface SentryIssueNode {
  readonly project: string;
  /** Numeric group id (returned as a string by the API). The writeback key. */
  readonly id: string;
  /** Human short id, e.g. `BACKEND-7` (display only). */
  readonly shortId: string;
  readonly title: string;
  /** Where the error happened (function / route) — used as the task body. */
  readonly culprit: string | null;
  readonly permalink: string | null;
  /** `unresolved` | `resolved` | `ignored` | `muted`. */
  readonly status: string;
  /** `fatal` | `error` | `warning` | `info` | `debug` | null. */
  readonly level: string | null;
  /** Last-seen ISO timestamp. */
  readonly lastSeen: string | null;
  /** Assignee display name / email, if any. */
  readonly assignee: string | null;
}

export interface SentryClientLike {
  /**
   * Unresolved issues for one project, newest-first-seen, up to `limit`.
   * Paginates via the `Link` cursor when `limit` exceeds one page.
   */
  listUnresolvedIssues(project: string, limit: number): Promise<readonly SentryIssueNode[]>;
  /** Search unresolved issues within one project (`query=is:unresolved <term>`). */
  searchIssues(term: string, limit: number, project: string): Promise<readonly SentryIssueNode[]>;
  /** Post an internal note/comment on an issue. */
  addNote(issueId: string, text: string): Promise<void>;
  /** Mark an issue resolved (org-scoped endpoint). */
  resolveIssue(issueId: string): Promise<void>;
}

export class SentryApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SentryApiError';
  }
}

type FetchLike = typeof fetch;

interface RawIssue {
  id?: string | number | null;
  shortId?: string | null;
  title?: string | null;
  culprit?: string | null;
  permalink?: string | null;
  status?: string | null;
  level?: string | null;
  lastSeen?: string | null;
  metadata?: { value?: string | null; type?: string | null } | null;
  assignedTo?: { name?: string | null; email?: string | null } | null;
}

/** Build a real `SentryClientLike` backed by the Sentry REST API. */
export function createSentryClient(
  token: string,
  opts: { readonly org: string; readonly baseUrl: string; readonly fetchImpl?: FetchLike },
): SentryClientLike {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const org = opts.org;
  const apiBase = `${opts.baseUrl.replace(/\/+$/, '')}${API_PREFIX}`;

  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...extra,
    };
  }

  async function request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      throw new SentryApiError(
        `Sentry request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Throw a descriptive error for a non-OK response. */
  async function fail(resp: Response, context: string): Promise<never> {
    const body = await resp.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 300)}` : '';
    if (resp.status === 401) {
      throw new SentryApiError(`Sentry auth failed (401) on ${context}: check the token${detail}`, 401);
    }
    if (resp.status === 403) {
      throw new SentryApiError(`Sentry forbidden (403) on ${context} (token scope?)${detail}`, 403);
    }
    if (resp.status === 404) {
      throw new SentryApiError(
        `Sentry not found (404) on ${context}: org/project missing or no access${detail}`,
        404,
      );
    }
    throw new SentryApiError(`Sentry API ${resp.status} ${resp.statusText} on ${context}${detail}`, resp.status);
  }

  function mapIssue(raw: RawIssue, project: string): SentryIssueNode {
    return {
      project,
      id: raw.id !== undefined && raw.id !== null ? String(raw.id) : '',
      shortId: raw.shortId ?? '',
      title: (raw.title ?? raw.metadata?.value ?? '').trim(),
      culprit: raw.culprit ?? raw.metadata?.value ?? null,
      permalink: raw.permalink ?? null,
      status: raw.status ?? 'unresolved',
      level: raw.level ?? null,
      lastSeen: raw.lastSeen ?? null,
      assignee: raw.assignedTo?.name ?? raw.assignedTo?.email ?? null,
    };
  }

  /**
   * Extract the `rel="next"` URL from a `Link` header, but ONLY when Sentry
   * tagged it `results="true"` (Sentry always emits a `next` link — it sets
   * `results="false"` when there are no more pages).
   */
  function nextLink(linkHeader: string | null): string | undefined {
    if (!linkHeader) return undefined;
    for (const part of linkHeader.split(',')) {
      if (!/rel="next"/.test(part)) continue;
      if (!/results="true"/.test(part)) return undefined;
      const m = part.match(/<([^>]+)>/);
      if (m) return m[1];
    }
    return undefined;
  }

  async function listWithQuery(
    project: string,
    query: string,
    limit: number,
    context: string,
  ): Promise<SentryIssueNode[]> {
    const perPage = Math.min(limit, MAX_PER_PAGE);
    // `statsPeriod=` (empty) disables the default 24h activity window so a brand
    // new error isn't filtered by recency; `sort=new` returns newest-first-seen.
    let url =
      `${apiBase}/projects/${org}/${project}/issues/` +
      `?query=${encodeURIComponent(query)}&sort=new&statsPeriod=&limit=${perPage}`;

    const collected: SentryIssueNode[] = [];
    while (collected.length < limit) {
      const resp = await request(url, { method: 'GET', headers: headers() });
      if (!resp.ok) await fail(resp, context);
      const raws = (await resp.json()) as RawIssue[];
      for (const raw of raws) collected.push(mapIssue(raw, project));
      const next = nextLink(resp.headers.get('link'));
      if (next === undefined || raws.length === 0) break;
      url = next;
    }
    return collected.slice(0, limit);
  }

  return {
    async listUnresolvedIssues(project, limit) {
      return listWithQuery(project, 'is:unresolved', limit, `list issues for ${org}/${project}`);
    },

    async searchIssues(term, limit, project) {
      const query = `is:unresolved ${term}`.trim();
      return listWithQuery(project, query, limit, `search issues for ${org}/${project}`);
    },

    async addNote(issueId, text) {
      const url = `${apiBase}/issues/${issueId}/notes/`;
      const resp = await request(url, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) await fail(resp, `add note on issue ${issueId}`);
    },

    async resolveIssue(issueId) {
      const url = `${apiBase}/organizations/${org}/issues/${issueId}/`;
      const resp = await request(url, {
        method: 'PUT',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ status: 'resolved' }),
      });
      if (!resp.ok) await fail(resp, `resolve issue ${issueId}`);
    },
  };
}
