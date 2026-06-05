/**
 * Phase 8C.3 — narrow Jira Cloud REST v3 client seam.
 *
 * Mirrors the GitHub/GitLab clients: the connector talks to this interface,
 * never the raw API, so unit tests substitute a hand-written fake without any
 * network. Thin REST layer over global `fetch`.
 *
 * Auth: Jira Cloud uses HTTP Basic with `email:apiToken` base64-encoded
 * (`Authorization: Basic <b64>`). NOT a bearer token — that's OAuth.
 *
 * Search: the legacy offset-based `POST /rest/api/3/search` (with `startAt` /
 * `total`) was DEPRECATED 2025-05-01 and fully removed for Jira Cloud by the end
 * of October 2025. This client uses the replacement enhanced-JQL endpoint
 * `POST /rest/api/3/search/jql`, which paginates by an opaque `nextPageToken`
 * and returns NO `total` (response: `{ issues, nextPageToken?, isLast }`). The
 * new endpoint also rejects fully-unbounded JQL, so the connector anchors every
 * fetch query on a real clause (`statusCategory != Done`, a project/assignee
 * filter, …) rather than a bare `ORDER BY`.
 *
 * Description fields are ADF (Atlassian Document Format, v3-only); the client
 * flattens them to plain text via `flattenAdf` (ported from emdash). Comments
 * posted back must ALSO be ADF documents (`textToAdf`).
 */

/** A normalized Jira issue (the client flattens ADF + lifts nested fields). */
export interface JiraIssueNode {
  /** The human-readable issue key, e.g. `ENG-123` — the writeback target. */
  readonly key: string;
  readonly summary: string;
  readonly description: string | null;
  readonly webUrl: string;
  /** Status display name (e.g. `In Progress`). */
  readonly statusName: string | null;
  /** Status category key: `new` | `indeterminate` | `done`. `done` ⇒ terminal. */
  readonly statusCategoryKey: string | null;
  /** Priority name (e.g. `High`), or null. */
  readonly priorityName: string | null;
  readonly labels: readonly string[];
  readonly assignee: string | null;
  /** The project key (e.g. `ENG`) — routing hint. */
  readonly projectKey: string | null;
  readonly updatedAt: string | null;
}

/** An available workflow transition for an issue. */
export interface JiraTransition {
  readonly id: string;
  readonly name: string;
  /** Status category key of the transition TARGET (`done` ⇒ a Done transition). */
  readonly toStatusCategoryKey: string | null;
}

export interface JiraClientLike {
  /** Run a JQL query (token-paginated up to `limit`). */
  searchByJql(jql: string, limit: number): Promise<readonly JiraIssueNode[]>;
  /** Final fallback: keys of recently-viewed/history issues (permission-blind). */
  getRecentIssueKeys(limit: number): Promise<readonly string[]>;
  /** Hydrate one issue by key (used by the picker fallback). */
  getIssue(key: string): Promise<JiraIssueNode | null>;
  /** The available workflow transitions for an issue. */
  getTransitions(key: string): Promise<readonly JiraTransition[]>;
  /** Apply a transition by id. */
  transitionIssue(key: string, transitionId: string): Promise<void>;
  /** Post a comment (text → ADF document). */
  addComment(key: string, text: string): Promise<void>;
  /** Connection check — the authenticated user's display name, or null. */
  getMyself(): Promise<{ readonly displayName: string } | null>;
}

export class JiraApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}

/** Jira caps `maxResults`; keep pages modest for reliability. */
const MAX_PER_PAGE = 100;
/** Hard ceiling on pages walked, so a misbehaving `nextPageToken` can't loop. */
const MAX_PAGES = 50;

const SEARCH_FIELDS = [
  'summary',
  'description',
  'updated',
  'project',
  'status',
  'assignee',
  'priority',
  'labels',
] as const;

type FetchLike = typeof fetch;

interface RawAdfNode {
  type?: string;
  text?: string;
  content?: RawAdfNode[];
}

interface RawIssue {
  key?: string | null;
  fields?: {
    summary?: string | null;
    description?: RawAdfNode | string | null;
    updated?: string | null;
    project?: { key?: string | null } | null;
    status?: { name?: string | null; statusCategory?: { key?: string | null } | null } | null;
    assignee?: { displayName?: string | null } | null;
    priority?: { name?: string | null } | null;
    labels?: string[] | null;
  } | null;
}

export interface JiraClientCredentials {
  readonly siteUrl: string;
  readonly email: string;
  readonly token: string;
}

/**
 * Flatten an Atlassian Document Format node to plain text. Ported verbatim from
 * emdash `JiraService.ts:336-352` — block-level containers (`doc`,
 * `bulletList`, `orderedList`) join their children with newlines; inline
 * containers (`paragraph`, `heading`, `listItem`) and everything else join with
 * the empty string. Non-text leaf nodes (mention, emoji, media, hardBreak, …)
 * flatten to `''`.
 */
export function flattenAdf(node: RawAdfNode | string | null | undefined): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (Array.isArray(node.content)) {
    const parts = node.content.map((c) => flattenAdf(c));
    if (node.type === 'doc' || node.type === 'bulletList' || node.type === 'orderedList') {
      return parts.join('\n');
    }
    return parts.join('');
  }
  return '';
}

/** Wrap plain text in a minimal ADF document for the comment endpoint (v3). */
export function textToAdf(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

/** Build a real `JiraClientLike` backed by the Jira Cloud REST v3 API. */
export function createJiraClient(
  creds: JiraClientCredentials,
  opts: { readonly fetchImpl?: FetchLike } = {},
): JiraClientLike {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = creds.siteUrl.replace(/\/+$/, '');
  const apiBase = `${base}/rest/api/3`;
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString('base64');

  function headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Basic ${auth}`,
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
      throw new JiraApiError(
        `Jira request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function fail(resp: Response, context: string): Promise<never> {
    const body = await resp.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 300)}` : '';
    if (resp.status === 401) {
      throw new JiraApiError(`Jira auth failed (401) on ${context}: check email/token${detail}`, 401);
    }
    if (resp.status === 403) {
      throw new JiraApiError(`Jira forbidden (403) on ${context} (permission?)${detail}`, 403);
    }
    if (resp.status === 404) {
      throw new JiraApiError(`Jira not found (404) on ${context}${detail}`, 404);
    }
    throw new JiraApiError(`Jira API ${resp.status} ${resp.statusText} on ${context}${detail}`, resp.status);
  }

  function mapIssue(raw: RawIssue): JiraIssueNode {
    const f = raw.fields ?? {};
    const key = (raw.key ?? '').trim();
    return {
      key,
      summary: (f.summary ?? '').trim(),
      description: f.description != null ? flattenAdf(f.description) : null,
      webUrl: key.length > 0 ? `${base}/browse/${key}` : '',
      statusName: f.status?.name ?? null,
      statusCategoryKey: f.status?.statusCategory?.key ?? null,
      priorityName: f.priority?.name ?? null,
      labels: (f.labels ?? []).filter((l): l is string => typeof l === 'string' && l.length > 0),
      assignee: f.assignee?.displayName ?? null,
      projectKey: f.project?.key ?? null,
      updatedAt: f.updated ?? null,
    };
  }

  return {
    async searchByJql(jql, limit) {
      const out: JiraIssueNode[] = [];
      let token: string | undefined;
      for (let page = 0; page < MAX_PAGES && out.length < limit; page += 1) {
        const maxResults = Math.min(limit - out.length, MAX_PER_PAGE);
        const resp = await request(`${apiBase}/search/jql`, {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({
            jql,
            maxResults,
            fields: [...SEARCH_FIELDS],
            ...(token !== undefined ? { nextPageToken: token } : {}),
          }),
        });
        if (!resp.ok) await fail(resp, 'search issues');
        const data = (await resp.json()) as {
          issues?: RawIssue[];
          nextPageToken?: string | null;
          isLast?: boolean | null;
        };
        const issues = data.issues ?? [];
        for (const raw of issues) out.push(mapIssue(raw));
        // Stop on the last page, an absent token, or a zero-issue page (defends
        // against the documented "token never advances" Cloud bug).
        if (data.isLast === true || issues.length === 0) break;
        token = data.nextPageToken ?? undefined;
        if (token === undefined) break;
      }
      return out.slice(0, limit);
    },

    async getRecentIssueKeys(limit) {
      const resp = await request(`${apiBase}/issue/picker`, { method: 'GET', headers: headers() });
      if (!resp.ok) await fail(resp, 'recent issues');
      const data = (await resp.json()) as {
        sections?: Array<{ issues?: Array<{ key?: string | null }> }>;
      };
      const keys: string[] = [];
      const seen = new Set<string>();
      for (const section of data.sections ?? []) {
        for (const issue of section.issues ?? []) {
          const k = (issue.key ?? '').trim();
          if (k.length > 0 && !seen.has(k)) {
            seen.add(k);
            keys.push(k);
            if (keys.length >= limit) return keys;
          }
        }
      }
      return keys;
    },

    async getIssue(key) {
      const fields = SEARCH_FIELDS.join(',');
      const resp = await request(
        `${apiBase}/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields)}`,
        { method: 'GET', headers: headers() },
      );
      if (resp.status === 404) return null;
      if (!resp.ok) await fail(resp, `get issue ${key}`);
      return mapIssue((await resp.json()) as RawIssue);
    },

    async getTransitions(key) {
      const resp = await request(`${apiBase}/issue/${encodeURIComponent(key)}/transitions`, {
        method: 'GET',
        headers: headers(),
      });
      if (!resp.ok) await fail(resp, `get transitions for ${key}`);
      const data = (await resp.json()) as {
        transitions?: Array<{
          id?: string | null;
          name?: string | null;
          to?: { statusCategory?: { key?: string | null } | null } | null;
        }>;
      };
      return (data.transitions ?? [])
        .filter((t): t is { id: string; name?: string | null; to?: { statusCategory?: { key?: string | null } | null } | null } => typeof t.id === 'string' && t.id.length > 0)
        .map((t) => ({
          id: t.id,
          name: t.name ?? '',
          toStatusCategoryKey: t.to?.statusCategory?.key ?? null,
        }));
    },

    async transitionIssue(key, transitionId) {
      const resp = await request(`${apiBase}/issue/${encodeURIComponent(key)}/transitions`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ transition: { id: transitionId } }),
      });
      if (!resp.ok) await fail(resp, `transition ${key}`);
    },

    async addComment(key, text) {
      const resp = await request(`${apiBase}/issue/${encodeURIComponent(key)}/comment`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ body: textToAdf(text) }),
      });
      if (!resp.ok) await fail(resp, `comment on ${key}`);
    },

    async getMyself() {
      const resp = await request(`${apiBase}/myself`, { method: 'GET', headers: headers() });
      if (!resp.ok) await fail(resp, 'get authenticated user');
      const data = (await resp.json()) as { displayName?: string | null };
      return data.displayName ? { displayName: data.displayName } : null;
    },
  };
}
