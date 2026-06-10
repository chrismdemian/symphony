import { z } from 'zod';

/**
 * jira-source — a self-contained, raw-`fetch` port of Symphony's in-tree Jira
 * connector (`src/integrations/jira.ts` + `jira-client.ts` + `jira-config.ts`).
 * A plugin can't import app internals, so the Jira I/O + the JQL fallback chain
 * + ADF flattening live here; `index.ts` is just config-load + tool
 * registration.
 *
 * Auth: Jira Cloud uses HTTP Basic with `email:apiToken` base64-encoded
 * (`Authorization: Basic <b64>`). NOT a bearer token — that's OAuth. Both the
 * `siteUrl` and `email` are REQUIRED in config.json (the config IS the
 * activation for a plugin; the in-tree connector treats the sidecar as
 * optional).
 *
 * Search: the legacy offset-based `POST /rest/api/3/search` was removed for
 * Jira Cloud (end Oct 2025). This port uses the enhanced-JQL endpoint
 * `POST /rest/api/3/search/jql` (token pagination, NO `total`), which rejects
 * fully-unbounded JQL — so every fetch query is anchored on a real clause
 * (`statusCategory != Done`, a project/assignee filter, …).
 */

// ── config ───────────────────────────────────────────────────────────────

/** A Jira project key: leading letter, then letters/digits/underscore. */
const PROJECT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export const JiraSourceConfigSchema = z.object({
  /** Jira Cloud API token (the Basic-auth password). */
  token: z.string().min(1),
  /** Jira base URL (e.g. `https://acme.atlassian.net`). https-only (localhost exempt). */
  siteUrl: z
    .string()
    .url()
    .refine(
      (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(u),
      'siteUrl must be https:// (http:// is allowed only for localhost)',
    ),
  /** Atlassian account email — the Basic-auth username. */
  email: z.string().email(),
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
  /** Max issues per fetch when the caller omits `limit`. */
  fetchLimit: z.number().int().min(1).max(500).optional(),
});

export type JiraSourceConfig = z.infer<typeof JiraSourceConfigSchema>;

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

// ── Jira shapes ────────────────────────────────────────────────────────────

/** A normalized Jira issue (ADF flattened + nested fields lifted). */
export interface JiraIssueNode {
  /** The human-readable issue key, e.g. `ENG-123` — the writeback target. */
  readonly key: string;
  readonly summary: string;
  readonly description: string | null;
  readonly webUrl: string;
  readonly statusName: string | null;
  /** Status category key: `new` | `indeterminate` | `done`. `done` ⇒ terminal. */
  readonly statusCategoryKey: string | null;
  readonly priorityName: string | null;
  readonly labels: readonly string[];
  readonly assignee: string | null;
  readonly projectKey: string | null;
  readonly updatedAt: string | null;
}

export interface JiraTransition {
  readonly id: string;
  readonly name: string;
  /** Status category key of the transition TARGET (`done` ⇒ a Done transition). */
  readonly toStatusCategoryKey: string | null;
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

// ── pure mapping helpers (unit-tested directly) ───────────────────────────

/**
 * Flatten an Atlassian Document Format node to plain text. Ported verbatim from
 * emdash `JiraService.ts:336-352` — block-level containers (`doc`,
 * `bulletList`, `orderedList`) join their children with newlines; inline
 * containers (`paragraph`, `heading`, `listItem`) and everything else join with
 * the empty string. Non-text leaf nodes (mention, emoji, media, …) → `''`.
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

/**
 * Map a Jira priority name to a Symphony integer (higher = sooner, default 0),
 * on the same 0-3 scale as the Linear/GitHub connectors.
 */
export function jiraPriorityToSymphony(priorityName: string | null): number {
  if (priorityName === null) return 0;
  switch (priorityName.trim().toLowerCase()) {
    case 'highest':
    case 'urgent':
    case 'blocker':
    case 'critical':
      return 3;
    case 'high':
      return 2;
    case 'medium':
      return 1;
    default:
      // low / lowest / trivial / minor / unknown → floor.
      return 0;
  }
}

/** Map a raw Jira REST issue to the normalized `JiraIssueNode` (ADF flattened). */
export function mapRawIssue(raw: RawIssue, base: string): JiraIssueNode {
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

/** Map a `JiraIssueNode` to a `NormalizedIssue`. Pure: no I/O. */
export function mapJiraIssue(node: JiraIssueNode): NormalizedIssue {
  const title = node.summary.trim();
  return {
    externalId: node.key,
    title: title.length > 0 ? title : `(untitled Jira issue ${node.key})`,
    url: node.webUrl.length > 0 ? node.webUrl : null,
    state: node.statusName,
    isTerminal: node.statusCategoryKey === 'done',
    body: node.description,
    assignee: node.assignee,
    labels: [...node.labels],
    // Route by the project key — a Symphony project named after it gets it.
    projectValue: node.projectKey !== null && node.projectKey.length > 0 ? node.projectKey : null,
    priority: jiraPriorityToSymphony(node.priorityName),
    updatedAt: node.updatedAt,
  };
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

// ── the Jira REST client + connector ───────────────────────────────────────

const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_COMPLETED_COMMENT = 'Completed by Symphony.';
/** Anchor every fetch candidate so the query stays bounded (the enhanced-search
 *  endpoint rejects fully-unbounded JQL) AND skips done work at the source. */
const NOT_DONE = 'statusCategory != Done';
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

/**
 * The Jira issue source. Owns all Jira I/O behind a serialized throttle.
 * `fetchImpl` is injectable so unit tests can drive it without a network.
 */
export class JiraSource {
  private readonly throttle = new RequestThrottle(DEFAULT_MIN_GAP_MS);
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly apiBase: string;
  private readonly auth: string;

  constructor(
    private readonly config: JiraSourceConfig,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.base = config.siteUrl.replace(/\/+$/, '');
    this.apiBase = `${this.base}/rest/api/3`;
    this.auth = Buffer.from(`${config.email}:${config.token}`).toString('base64');
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Basic ${this.auth}`,
      accept: 'application/json',
      ...extra,
    };
  }

  private async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      throw new JiraApiError(
        `Jira request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async fail(resp: Response, context: string): Promise<never> {
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

  private async searchByJql(jql: string, limit: number): Promise<JiraIssueNode[]> {
    const out: JiraIssueNode[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES && out.length < limit; page += 1) {
      const maxResults = Math.min(limit - out.length, MAX_PER_PAGE);
      const resp = await this.request(`${this.apiBase}/search/jql`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          jql,
          maxResults,
          fields: [...SEARCH_FIELDS],
          ...(token !== undefined ? { nextPageToken: token } : {}),
        }),
      });
      if (!resp.ok) await this.fail(resp, 'search issues');
      const data = (await resp.json()) as {
        issues?: RawIssue[];
        nextPageToken?: string | null;
        isLast?: boolean | null;
      };
      const issues = data.issues ?? [];
      for (const raw of issues) out.push(mapRawIssue(raw, this.base));
      // Stop on the last page, an absent token, or a zero-issue page (defends
      // against the documented "token never advances" Cloud bug).
      if (data.isLast === true || issues.length === 0) break;
      token = data.nextPageToken ?? undefined;
      if (token === undefined) break;
    }
    return out.slice(0, limit);
  }

  private async getRecentIssueKeys(limit: number): Promise<string[]> {
    const resp = await this.request(`${this.apiBase}/issue/picker`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!resp.ok) await this.fail(resp, 'recent issues');
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
  }

  private async getIssue(key: string): Promise<JiraIssueNode | null> {
    const fields = SEARCH_FIELDS.join(',');
    const resp = await this.request(
      `${this.apiBase}/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields)}`,
      { method: 'GET', headers: this.headers() },
    );
    if (resp.status === 404) return null;
    if (!resp.ok) await this.fail(resp, `get issue ${key}`);
    return mapRawIssue((await resp.json()) as RawIssue, this.base);
  }

  private async getTransitions(key: string): Promise<JiraTransition[]> {
    const resp = await this.request(`${this.apiBase}/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!resp.ok) await this.fail(resp, `get transitions for ${key}`);
    const data = (await resp.json()) as {
      transitions?: Array<{
        id?: string | null;
        name?: string | null;
        to?: { statusCategory?: { key?: string | null } | null } | null;
      }>;
    };
    return (data.transitions ?? [])
      .filter((t): t is { id: string; name?: string | null; to?: { statusCategory?: { key?: string | null } | null } | null } =>
        typeof t.id === 'string' && t.id.length > 0,
      )
      .map((t) => ({
        id: t.id,
        name: t.name ?? '',
        toStatusCategoryKey: t.to?.statusCategory?.key ?? null,
      }));
  }

  private async transitionIssue(key: string, transitionId: string): Promise<void> {
    const resp = await this.request(`${this.apiBase}/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
    if (!resp.ok) await this.fail(resp, `transition ${key}`);
  }

  private async addComment(key: string, text: string): Promise<void> {
    const resp = await this.request(`${this.apiBase}/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ body: textToAdf(text) }),
    });
    if (!resp.ok) await this.fail(resp, `comment on ${key}`);
  }

  /** The ordered JQL candidates: configured projects → assignee → reporter →
   *  the bounded `statusCategory != Done` catch-all. */
  private jqlCandidates(): string[] {
    const candidates: string[] = [];
    if (this.config.projectKeys.length > 0) {
      const keys = this.config.projectKeys.join(', ');
      candidates.push(`project IN (${keys}) AND ${NOT_DONE} ORDER BY updated DESC`);
    }
    candidates.push(
      `assignee = currentUser() AND ${NOT_DONE} ORDER BY updated DESC`,
      `reporter = currentUser() AND ${NOT_DONE} ORDER BY updated DESC`,
      `${NOT_DONE} ORDER BY updated DESC`,
    );
    return candidates;
  }

  /**
   * Pull open issues via the JQL fallback chain, then the issue-picker history
   * (permission-blind) as the final fallback. Returns terminal issues too (the
   * ingest skips them — earns its keep on the picker path, which returns all
   * statuses).
   */
  async fetchOpenIssues(limit?: number): Promise<NormalizedIssue[]> {
    const cap = limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT;

    for (const jql of this.jqlCandidates()) {
      try {
        const nodes = await this.throttle.run(() => this.searchByJql(jql, cap));
        if (nodes.length > 0) return nodes.map((n) => mapJiraIssue(n));
      } catch {
        // Forbidden / unbrowsable project → try the next, narrower candidate.
      }
    }

    try {
      const keys = await this.throttle.run(() => this.getRecentIssueKeys(cap));
      const out: NormalizedIssue[] = [];
      for (const key of keys.slice(0, cap)) {
        try {
          const node = await this.throttle.run(() => this.getIssue(key));
          if (node !== null) out.push(mapJiraIssue(node));
        } catch {
          // Skip an individual issue we can't read.
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async searchIssues(term: string, limit?: number): Promise<NormalizedIssue[]> {
    const cap = limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT;
    const sanitized = term.replace(/"/g, '\\"');
    const jql = `text ~ "${sanitized}" ORDER BY updated DESC`;
    const nodes = await this.throttle.run(() => this.searchByJql(jql, cap));
    return nodes.map((n) => mapJiraIssue(n));
  }

  /**
   * Push a terminal task status to a Jira issue: comment + transition to a
   * Done-category state on completion; comment-only (never transition) on
   * failure, and only when configured.
   */
  async writeBack(externalId: string, status: 'completed' | 'failed'): Promise<WritebackResult> {
    const key = externalId.trim();
    if (key.length === 0) {
      return { written: false, code: 'not-found', reason: `empty Jira key '${externalId}'` };
    }

    if (status === 'failed') {
      const comment = this.config.statusWriteback.failed;
      if (comment === undefined) {
        return { written: false, code: 'skipped', reason: "no 'failed' writeback configured" };
      }
      try {
        await this.throttle.run(() => this.addComment(key, comment));
        return { written: true, code: 'written', value: 'commented (no transition)' };
      } catch (err) {
        return this.writebackError(err, key);
      }
    }

    // completed → comment (configured or default) then transition to Done.
    const comment = this.config.statusWriteback.completed ?? DEFAULT_COMPLETED_COMMENT;
    try {
      await this.throttle.run(() => this.addComment(key, comment));
    } catch (err) {
      return this.writebackError(err, key);
    }

    let transitions: JiraTransition[];
    try {
      transitions = await this.throttle.run(() => this.getTransitions(key));
    } catch (err) {
      return this.writebackError(err, key);
    }
    const override = this.config.statusWriteback.completedTransition;
    const target =
      override !== undefined
        ? transitions.find((t) => t.name.toLowerCase() === override.toLowerCase())
        : transitions.find((t) => t.toStatusCategoryKey === 'done');
    if (target === undefined) {
      // The comment DID post, but the writeback's primary intent (move to Done)
      // couldn't be resolved — report `written: false` so the host surfaces the
      // reason as a warning. `written: true` would log a plain success and drop
      // the reason. The Done target couldn't be resolved → `not-found`.
      return {
        written: false,
        code: 'not-found',
        reason:
          override !== undefined
            ? `commented, but no transition named '${override}' is available on ${key}`
            : `commented, but no Done transition is available on ${key}`,
      };
    }
    try {
      await this.throttle.run(() => this.transitionIssue(key, target.id));
      return { written: true, code: 'written', value: `commented + transitioned to '${target.name}'` };
    } catch (err) {
      return this.writebackError(err, key);
    }
  }

  private writebackError(err: unknown, ref: string): WritebackResult {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof JiraApiError && err.status === 404) {
      return { written: false, code: 'not-found', reason: `Jira issue ${ref} not found` };
    }
    return { written: false, code: 'error', reason };
  }

  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const resp = await this.throttle.run(() =>
        this.request(`${this.apiBase}/myself`, { method: 'GET', headers: this.headers() }),
      );
      if (!resp.ok) await this.fail(resp, 'get authenticated user');
      const data = (await resp.json()) as { displayName?: string | null };
      return data.displayName
        ? { ok: true, detail: `authenticated as ${data.displayName}` }
        : { ok: false, detail: 'authenticated, but no user returned' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
