import { z } from 'zod';

/**
 * sentry-source — a self-contained, raw-`fetch` port of Symphony's in-tree
 * Sentry connector (`src/integrations/sentry.ts` + `sentry-client.ts` +
 * `sentry-config.ts`). A plugin can't import app internals, so the Sentry REST
 * I/O + the issue/priority mapping live here as plain, testable code; `index.ts`
 * is just config-load + tool registration.
 *
 * Auth: a Sentry **auth token** (user auth token, internal-integration token, or
 * org auth token) in `Authorization: Bearer <token>`. Reading issues needs the
 * `event:read` scope; the opt-in resolve writeback needs `event:write`. (A Sentry
 * DSN is NOT a token — it's a write-only ingestion key.) The token is read from
 * `<install-dir>/config.json`, never Symphony's keychain.
 *
 * The entity is an error GROUP (issue). The `externalId` is
 * `<project>#<numericGroupId>` — the project routes to a Symphony project, the
 * numeric group id is every writeback's key.
 *
 * Writeback diverges from the issue-tracker connectors by design: a worker that
 * INVESTIGATED a Sentry error has not necessarily FIXED it, so `completed` posts
 * an internal NOTE and only resolves when `resolveOnCompleted` is set.
 * Auto-resolving an unfixed error would hide a live production problem. `failed`
 * NEVER resolves (even with `resolveOnCompleted: true`).
 */

// ── config ───────────────────────────────────────────────────────────────

/** Default SaaS base; the client appends `/api/0`. */
const DEFAULT_BASE_URL = 'https://sentry.io';
/** Sentry org / project slugs: alnum start, then alnum + `.`, `_`, `-`. */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const SentrySourceConfigSchema = z.object({
  /** Sentry **auth token** (NOT a DSN) — the `Authorization: Bearer` value. */
  token: z.string().min(1),
  /** Sentry organization slug — every endpoint is org-scoped. REQUIRED. */
  org: z.string().regex(SLUG_RE, 'org must be a Sentry organization slug'),
  /**
   * Project slugs to pull unresolved issues from — AT LEAST ONE (the config IS
   * the activation for a plugin; Sentry needs to know which projects to read).
   */
  projects: z
    .array(z.string().regex(SLUG_RE, 'each project must be a Sentry project slug'))
    .min(1, 'at least one project slug is required'),
  /**
   * Sentry instance base URL. Omit for SaaS (`https://sentry.io`); set a region
   * host (`https://us.sentry.io`) or a self-hosted URL otherwise. The client
   * appends `/api/0`. MUST be https (http allowed only for localhost) — the token
   * rides this URL, so a non-TLS / arbitrary host is a leak surface.
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
   * Symphony terminal status → Sentry issue NOTE text (writeback). A note NEVER
   * changes the issue's status. `completed` always posts a note (configured or
   * default); `failed` posts a note only when configured.
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).optional(),
      failed: z.string().min(1).optional(),
    })
    .default({}),
  /**
   * Opt-in: ALSO mark the Sentry issue resolved on task completion. Default
   * false — investigating an error ≠ fixing it, and auto-resolving an unfixed
   * error would hide a live production problem. A failed task never resolves
   * regardless of this flag.
   */
  resolveOnCompleted: z.boolean().default(false),
  /** Max issues per project per fetch when the caller omits `limit`. */
  fetchLimit: z.number().int().min(1).max(500).optional(),
});

export type SentrySourceConfig = z.infer<typeof SentrySourceConfigSchema>;

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

// ── Sentry shapes ────────────────────────────────────────────────────────

/** A Sentry issue (error group), plus the project slug it came from. */
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

export class SentryApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SentryApiError';
  }
}

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

// ── pure mapping helpers (unit-tested directly) ───────────────────────────

/**
 * Sentry has no priority field — derive an integer (higher = sooner, default 0)
 * from the error `level`: fatal 3 / error 2 / warning 1 / info|debug|null 0.
 */
export function sentryLevelToPriority(level: string | null): number {
  switch ((level ?? '').toLowerCase()) {
    case 'fatal':
      return 3;
    case 'error':
      return 2;
    case 'warning':
      return 1;
    default:
      return 0;
  }
}

/**
 * Map a Sentry issue to a `NormalizedIssue`. `isTerminal` is `status !==
 * 'unresolved'` so the host's ingest skips resolved/ignored/muted issues. The
 * `externalId` is `<project>#<numericGroupId>`. The error `level` is surfaced as
 * a single pseudo-label so a trigger can scope by it (`--label fatal`). Pure: no I/O.
 */
export function mapSentryIssue(node: SentryIssueNode): NormalizedIssue {
  const title = node.title.trim();
  const ref = node.shortId.length > 0 ? node.shortId : `${node.project}#${node.id}`;
  return {
    externalId: `${node.project}#${node.id}`,
    title: title.length > 0 ? title : `(untitled Sentry issue ${ref})`,
    url: node.permalink !== null && node.permalink.length > 0 ? node.permalink : null,
    state: node.status,
    // unresolved is the only actionable state; resolved/ignored/muted are terminal.
    isTerminal: node.status !== 'unresolved',
    body: node.culprit,
    assignee: node.assignee,
    // Surface the error level as a pseudo-label so a trigger can scope by it
    // (`--label error` / `--label fatal`). Empty when the level is unknown.
    labels: node.level !== null && node.level.length > 0 ? [node.level] : [],
    // Route by the project slug — a Symphony project named after it gets it.
    projectValue: node.project.length > 0 ? node.project : null,
    priority: sentryLevelToPriority(node.level),
    updatedAt: node.lastSeen !== null && node.lastSeen.length > 0 ? node.lastSeen : null,
  };
}

/** Split `<project>#<numericId>` → `{project, id}`, or undefined when malformed. */
export function parseSentryExternalId(
  externalId: string,
): { project: string; id: string } | undefined {
  const hash = externalId.lastIndexOf('#');
  if (hash <= 0 || hash === externalId.length - 1) return undefined;
  const project = externalId.slice(0, hash);
  const id = externalId.slice(hash + 1);
  // Strict decimal id only — Sentry group ids are numeric strings.
  if (project.length === 0 || !/^[0-9]+$/.test(id)) return undefined;
  return { project, id };
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

// ── the Sentry REST client + connector ─────────────────────────────────────

const API_PREFIX = '/api/0';
const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_COMPLETED_NOTE = 'Investigated by Symphony.';
/** Sentry caps issue list pages at 100. */
const MAX_PER_PAGE = 100;

type FetchLike = typeof fetch;

/**
 * The Sentry issue source. Owns all Sentry I/O behind a serialized throttle.
 * `fetchImpl` is injectable so unit tests can drive it without a network.
 */
export class SentrySource {
  private readonly throttle = new RequestThrottle(DEFAULT_MIN_GAP_MS);
  private readonly fetchImpl: FetchLike;
  private readonly org: string;
  private readonly apiBase: string;

  constructor(
    private readonly config: SentrySourceConfig,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.org = config.org;
    this.apiBase = `${(config.siteUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}${API_PREFIX}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.config.token}`, accept: 'application/json', ...extra };
  }

  private async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      throw new SentryApiError(
        `Sentry request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async fail(resp: Response, context: string): Promise<never> {
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

  private mapRaw(raw: RawIssue, project: string): SentryIssueNode {
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
  private nextLink(linkHeader: string | null): string | undefined {
    if (!linkHeader) return undefined;
    for (const part of linkHeader.split(',')) {
      if (!/rel="next"/.test(part)) continue;
      if (!/results="true"/.test(part)) return undefined;
      const m = part.match(/<([^>]+)>/);
      if (m) return m[1];
    }
    return undefined;
  }

  private async listWithQuery(
    project: string,
    query: string,
    limit: number,
    context: string,
  ): Promise<SentryIssueNode[]> {
    const perPage = Math.min(limit, MAX_PER_PAGE);
    // `statsPeriod=` (empty) disables the default 24h activity window so a brand
    // new error isn't filtered by recency; `sort=new` returns newest-first-seen.
    let url =
      `${this.apiBase}/projects/${this.org}/${project}/issues/` +
      `?query=${encodeURIComponent(query)}&sort=new&statsPeriod=&limit=${perPage}`;

    const collected: SentryIssueNode[] = [];
    while (collected.length < limit) {
      const resp = await this.request(url, { method: 'GET', headers: this.headers() });
      if (!resp.ok) await this.fail(resp, context);
      const raws = (await resp.json()) as RawIssue[];
      for (const raw of raws) collected.push(this.mapRaw(raw, project));
      const next = this.nextLink(resp.headers.get('link'));
      // Sentry always emits a `next` link; stop when results="false" (next ===
      // undefined) OR a defensive empty page (guards the "token never advances" bug).
      if (next === undefined || raws.length === 0) break;
      url = next;
    }
    return collected.slice(0, limit);
  }

  /** Pull unresolved issues across the configured projects (newest-first-seen). */
  async fetchOpenIssues(limit?: number): Promise<NormalizedIssue[]> {
    const cap = limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT;
    const out: NormalizedIssue[] = [];
    let firstError: unknown;
    let failures = 0;
    for (const project of this.config.projects) {
      try {
        const nodes = await this.throttle.run(() =>
          this.listWithQuery(project, 'is:unresolved', cap, `list issues for ${this.org}/${project}`),
        );
        for (const n of nodes) out.push(mapSentryIssue(n));
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

  /** Server-side search across the configured projects (`query=is:unresolved <term>`). */
  async searchIssues(term: string, limit?: number): Promise<NormalizedIssue[]> {
    const cap = limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT;
    const out: NormalizedIssue[] = [];
    for (const project of this.config.projects) {
      try {
        const query = `is:unresolved ${term}`.trim();
        const nodes = await this.throttle.run(() =>
          this.listWithQuery(project, query, cap, `search issues for ${this.org}/${project}`),
        );
        for (const n of nodes) out.push(mapSentryIssue(n));
      } catch {
        // Skip a project we can't search; others still contribute.
      }
    }
    return out.slice(0, cap);
  }

  private async addNote(issueId: string, text: string): Promise<void> {
    const url = `${this.apiBase}/issues/${issueId}/notes/`;
    const resp = await this.request(url, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) await this.fail(resp, `add note on issue ${issueId}`);
  }

  private async resolveIssue(issueId: string): Promise<void> {
    const url = `${this.apiBase}/organizations/${this.org}/issues/${issueId}/`;
    const resp = await this.request(url, {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ status: 'resolved' }),
    });
    if (!resp.ok) await this.fail(resp, `resolve issue ${issueId}`);
  }

  /**
   * Push a terminal task status to a Sentry issue. `completed` always posts a
   * note; it resolves ONLY when `resolveOnCompleted` is set. `failed` posts a
   * note only when configured and NEVER resolves (even with `resolveOnCompleted`).
   */
  async writeBack(externalId: string, status: 'completed' | 'failed'): Promise<WritebackResult> {
    const parsed = parseSentryExternalId(externalId);
    if (parsed === undefined) {
      return { written: false, code: 'not-found', reason: `malformed Sentry id '${externalId}'` };
    }
    const { id } = parsed;

    if (status === 'failed') {
      // `failed` writeback only fires when a note is configured (Linear/Notion
      // convention) and NEVER resolves — a failed task leaves the issue open.
      const note = this.config.statusWriteback.failed;
      if (note === undefined) {
        return { written: false, code: 'skipped', reason: "no 'failed' writeback configured" };
      }
      try {
        await this.throttle.run(() => this.addNote(id, note));
        return { written: true, code: 'written', value: 'noted (left unresolved)' };
      } catch (err) {
        return this.writebackError(err, externalId);
      }
    }

    // completed → always post a note; resolve ONLY when opted in.
    const note = this.config.statusWriteback.completed ?? DEFAULT_COMPLETED_NOTE;
    try {
      await this.throttle.run(() => this.addNote(id, note));
      if (this.config.resolveOnCompleted) {
        await this.throttle.run(() => this.resolveIssue(id));
        return { written: true, code: 'written', value: 'noted + resolved' };
      }
      return { written: true, code: 'written', value: 'noted (left unresolved)' };
    } catch (err) {
      return this.writebackError(err, externalId);
    }
  }

  private writebackError(err: unknown, ref: string): WritebackResult {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof SentryApiError && err.status === 404) {
      return { written: false, code: 'not-found', reason: `Sentry issue ${ref} not found` };
    }
    return { written: false, code: 'error', reason };
  }

  /** Verify the token by listing one issue from the first configured project. */
  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    const project = this.config.projects[0];
    if (project === undefined) {
      return { ok: false, detail: 'no projects configured' };
    }
    try {
      // List-with-limit-1 verifies exactly the scope syncing needs (event:read);
      // a lighter org/viewer probe would need a scope a minimal token may lack.
      const issues = await this.throttle.run(() =>
        this.listWithQuery(project, 'is:unresolved', 1, `list issues for ${this.org}/${project}`),
      );
      return {
        ok: true,
        detail: `authenticated; reached ${this.org}/${project} (${issues.length} sample issue)`,
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
