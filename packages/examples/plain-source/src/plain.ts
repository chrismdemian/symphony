import { z } from 'zod';

/**
 * plain-source — a self-contained, raw-`fetch` port of Symphony's in-tree Plain
 * connector (`src/integrations/plain.ts` + `plain-client.ts` + `plain-config.ts`).
 * A plugin can't import app internals, so the Plain GraphQL I/O + the
 * thread/priority mapping live here as plain, testable code; `index.ts` is just
 * config-load + tool registration.
 *
 * Plain is a customer-support tool. The entity is a THREAD; the `externalId` is
 * the thread `id`. Plain has THREE statuses (`TODO` / `SNOOZED` / `DONE`); `DONE`
 * is terminal. Plain has no Symphony-project concept, so `projectValue` is always
 * `null` — threads route via the `sync_plain` `project:` arg / active-project
 * cursor.
 *
 * Auth: a Plain **API key** in `Authorization: Bearer <key>`. The key is read
 * from `<install-dir>/config.json`, never Symphony's keychain.
 *
 * Writeback uses an INTERNAL note (`createNote`) + `markThreadAsDone` — NEVER
 * `replyToThread`, which would EMAIL the customer. `createNote` requires a
 * `customerId`, which the client resolves via a `thread(threadId)` lookup before
 * noting; a missing thread surfaces as `not-found` (Plain has no HTTP 404 — every
 * response is HTTP 200, so a null thread is the only not-found signal). A `failed`
 * task only gets a note (when configured) and is left open for a human.
 *
 * GraphQL error model: the API returns HTTP 200 with `{ errors: [...] }` for
 * query-level errors AND a per-payload `{ data: { op: { error } } }` for
 * mutation-level errors — the client inspects BOTH, plus 401/403 for auth.
 */

// ── config ───────────────────────────────────────────────────────────────

/** Plain's three thread statuses. */
const PLAIN_THREAD_STATUSES = ['TODO', 'SNOOZED', 'DONE'] as const;
export type PlainThreadStatus = (typeof PLAIN_THREAD_STATUSES)[number];

export const PlainSourceConfigSchema = z.object({
  /** Plain API key (the `Authorization: Bearer` header value). */
  token: z.string().min(1),
  /**
   * Plain Core API GraphQL endpoint. Omit for the UK region default
   * (`https://core-api.uk.plain.com/graphql/v1`); override for other regions.
   * MUST be https (http allowed only for localhost) — the API key rides this
   * URL, so a non-TLS / arbitrary host is a leak surface.
   */
  apiUrl: z
    .string()
    .url()
    .refine(
      (u) => /^https:\/\//i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(u),
      'apiUrl must be https:// (http:// is allowed only for localhost)',
    )
    .optional(),
  /**
   * Thread statuses to import (default `["TODO"]`). `DONE` threads are terminal
   * and skipped by the host ingest regardless; include `SNOOZED` to also pull
   * snoozed threads.
   */
  statuses: z
    .array(z.enum(PLAIN_THREAD_STATUSES))
    .nonempty('at least one status')
    .default(['TODO']),
  /**
   * Symphony terminal status → Plain thread INTERNAL note text (writeback).
   * `completed` posts the note (configured or default) then marks the thread
   * DONE; `failed` writeback only fires when configured (omit to leave failed
   * tasks' threads untouched) and NEVER marks done. The note is an INTERNAL note,
   * never a customer-facing reply.
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).optional(),
      failed: z.string().min(1).optional(),
    })
    .default({}),
  /** Max threads per fetch when the caller omits `limit`. */
  fetchLimit: z.number().int().min(1).max(500).optional(),
});

export type PlainSourceConfig = z.infer<typeof PlainSourceConfigSchema>;

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

// ── Plain shapes ───────────────────────────────────────────────────────────

/** A normalized Plain thread (the client lifts nested fields + builds the URL). */
export interface PlainThreadNode {
  /** Thread id — the stable external id + writeback target. */
  readonly id: string;
  /** Human-readable ref, e.g. `T-747`. */
  readonly ref: string;
  readonly title: string;
  readonly previewText: string | null;
  /** `TODO` | `SNOOZED` | `DONE`. */
  readonly status: string;
  /** Plain numeric priority (0=urgent … 3=low), or null. */
  readonly priority: number | null;
  readonly labels: readonly string[];
  readonly updatedAt: string | null;
  /** App URL (workspace-scoped), or null when the workspace id is unavailable. */
  readonly url: string | null;
}

export class PlainApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PlainApiError';
  }
}

interface RawThread {
  id?: string | null;
  ref?: string | null;
  title?: string | null;
  previewText?: string | null;
  status?: string | null;
  priority?: number | null;
  customer?: { id?: string | null } | null;
  labels?: Array<{ labelType?: { name?: string | null } | null }> | null;
  updatedAt?: { iso8601?: string | null } | null;
}

interface MutationError {
  message?: string | null;
  type?: string | null;
  code?: string | null;
}

// ── GraphQL operations (verbatim against @team-plain/typescript-sdk) ──────

const THREAD_FIELDS = `
  id
  ref
  title
  previewText
  status
  priority
  customer { id }
  labels { labelType { name } }
  updatedAt { iso8601 }
`;

const LIST_THREADS_QUERY = `
query ListThreads($first: Int!, $after: String, $statuses: [ThreadStatus!]) {
  threads(first: $first, after: $after, filters: { statuses: $statuses }, sortBy: { field: CREATED_AT, direction: DESC }) {
    edges { node { ${THREAD_FIELDS} } }
    pageInfo { hasNextPage endCursor }
  }
}`;

const THREAD_CUSTOMER_QUERY = `
query ThreadCustomer($threadId: ID!) {
  thread(threadId: $threadId) { id customer { id } }
}`;

const MY_WORKSPACE_QUERY = `
query MyWorkspace { myWorkspace { id name } }`;

const MARK_THREAD_DONE_MUTATION = `
mutation MarkThreadAsDone($threadId: ID!) {
  markThreadAsDone(input: { threadId: $threadId }) {
    thread { id }
    error { message type code }
  }
}`;

const CREATE_NOTE_MUTATION = `
mutation CreateNote($customerId: ID!, $threadId: ID!, $text: String!, $markdown: String) {
  createNote(input: { customerId: $customerId, threadId: $threadId, text: $text, markdown: $markdown }) {
    note { id }
    error { message type code }
  }
}`;

// NOTE: `replyToThread` is DELIBERATELY UNUSED — it would email the customer.
// Plain writeback is internal-only (createNote + markThreadAsDone).

// ── pure mapping helpers (unit-tested directly) ───────────────────────────

/**
 * Plain priority is `0=urgent … 3=low` (lower number = more urgent). Symphony's
 * scale is the inverse (higher = sooner, default 0), so map urgent(0)→3,
 * high(1)→2, normal(2)→1, low(3)→0. Unknown / null → 0. Mirrors the Linear
 * priority inversion.
 */
export function plainPriorityToScore(priority: number | null): number {
  if (priority === null || !Number.isInteger(priority) || priority < 0 || priority > 3) return 0;
  return 3 - priority;
}

/**
 * Map a Plain thread to a `NormalizedIssue`. `isTerminal` is `status === 'DONE'`
 * so the host's ingest skips threads already done in Plain. The `externalId` is
 * the thread `id`. `projectValue` is always `null` (Plain has no project). Pure: no I/O.
 */
export function mapPlainThread(node: PlainThreadNode): NormalizedIssue {
  const title = node.title.trim();
  const label = node.ref.length > 0 ? node.ref : node.id;
  return {
    externalId: node.id,
    title: title.length > 0 ? title : `(untitled Plain thread ${label})`,
    url: node.url,
    state: node.status.length > 0 ? node.status : null,
    isTerminal: node.status === 'DONE',
    body: node.previewText,
    // Plain assignee resolution is a union type; skipped (not load-bearing).
    assignee: null,
    labels: [...node.labels],
    // Plain has no Symphony-project concept — route via the tool's `project:`
    // arg / active-project cursor (see issue-connector contract).
    projectValue: null,
    priority: plainPriorityToScore(node.priority),
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

// ── the Plain GraphQL client + connector ───────────────────────────────────

const DEFAULT_API_URL = 'https://core-api.uk.plain.com/graphql/v1';
const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_COMPLETED_NOTE = 'Completed by Symphony.';
/** Plain caps the `threads` connection `first` argument at 100. */
const MAX_FIRST = 100;
/** Max threads scanned for a client-side text search before filtering. */
const SEARCH_SCAN = 200;

type FetchLike = typeof fetch;

/**
 * The Plain issue source. Owns all Plain GraphQL I/O behind a serialized
 * throttle. `fetchImpl` is injectable so unit tests can drive it without a
 * network. The workspace id (for thread-URL construction) is fetched lazily once
 * and reused for the instance's lifetime.
 */
export class PlainSource {
  private readonly throttle = new RequestThrottle(DEFAULT_MIN_GAP_MS);
  private readonly fetchImpl: FetchLike;
  private readonly apiUrl: string;
  // undefined = not yet probed, null = probe failed/empty.
  private workspaceIdCache: string | null | undefined;

  constructor(
    private readonly config: PlainSourceConfig,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.apiUrl = config.apiUrl ?? DEFAULT_API_URL;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  /** Run a GraphQL operation; throw on transport, HTTP, or query-level errors. */
  private async gql<T>(
    query: string,
    variables: Record<string, unknown>,
    context: string,
  ): Promise<T> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.apiUrl, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new PlainApiError(
        `Plain request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new PlainApiError(
        `Plain auth failed (${resp.status}) on ${context}: check the API key`,
        resp.status,
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const detail = body ? `: ${body.slice(0, 300)}` : '';
      throw new PlainApiError(`Plain API ${resp.status} ${resp.statusText} on ${context}${detail}`, resp.status);
    }
    const json = (await resp.json().catch(() => ({}))) as {
      data?: T | null;
      errors?: Array<{ message?: string | null }> | null;
    };
    if (json.errors && json.errors.length > 0) {
      const msg = json.errors.map((e) => e.message ?? '?').join('; ');
      throw new PlainApiError(`Plain GraphQL error on ${context}: ${msg}`);
    }
    if (json.data === undefined || json.data === null) {
      throw new PlainApiError(`Plain API returned no data on ${context}`);
    }
    return json.data;
  }

  /** Throw if a mutation payload carries a non-null `error`. */
  private assertNoPayloadError(error: MutationError | null | undefined, context: string): void {
    if (error !== null && error !== undefined) {
      throw new PlainApiError(`Plain ${context} failed: ${error.message ?? error.code ?? 'unknown error'}`);
    }
  }

  private async ensureWorkspaceId(): Promise<string | null> {
    if (this.workspaceIdCache !== undefined) return this.workspaceIdCache;
    try {
      const ws = await this.fetchWorkspace();
      this.workspaceIdCache = ws?.id ?? null;
    } catch {
      // A display-URL helper must never abort a list — degrade to null.
      this.workspaceIdCache = null;
    }
    return this.workspaceIdCache;
  }

  private async fetchWorkspace(): Promise<{ id: string; name: string } | null> {
    const data = await this.gql<{ myWorkspace?: { id?: string | null; name?: string | null } | null }>(
      MY_WORKSPACE_QUERY,
      {},
      'workspace info',
    );
    const ws = data.myWorkspace;
    if (ws?.id == null || ws.id.length === 0) return null;
    return { id: ws.id, name: ws.name ?? ws.id };
  }

  private liftThread(raw: RawThread, workspaceId: string | null): PlainThreadNode {
    const id = (raw.id ?? '').trim();
    return {
      id,
      ref: (raw.ref ?? '').trim(),
      title: (raw.title ?? '').trim(),
      previewText: raw.previewText ?? null,
      status: raw.status ?? '',
      priority: typeof raw.priority === 'number' ? raw.priority : null,
      labels: (raw.labels ?? [])
        .map((l) => l.labelType?.name ?? '')
        .filter((n): n is string => n.length > 0),
      updatedAt: raw.updatedAt?.iso8601 ?? null,
      url:
        workspaceId !== null && id.length > 0
          ? `https://app.plain.com/workspace/${workspaceId}/thread/${id}`
          : null,
    };
  }

  /** Threads in the configured statuses, newest-created first (cursor-paginated). */
  private async listThreads(
    statuses: readonly PlainThreadStatus[],
    limit: number,
  ): Promise<PlainThreadNode[]> {
    const workspaceId = await this.ensureWorkspaceId();
    const out: PlainThreadNode[] = [];
    let after: string | undefined;
    while (out.length < limit) {
      const first = Math.min(limit - out.length, MAX_FIRST);
      const data = await this.gql<{
        threads?: {
          edges?: Array<{ node?: RawThread | null }> | null;
          pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
        } | null;
      }>(
        LIST_THREADS_QUERY,
        { first, after: after ?? null, statuses: [...statuses] },
        'list threads',
      );
      const conn = data.threads;
      const edges = conn?.edges ?? [];
      for (const edge of edges) {
        if (edge.node != null) out.push(this.liftThread(edge.node, workspaceId));
      }
      if (conn?.pageInfo?.hasNextPage !== true) break;
      const cursor = conn.pageInfo.endCursor;
      if (cursor == null || cursor.length === 0) break;
      after = cursor;
    }
    return out.slice(0, limit);
  }

  /** Pull open + done threads in the configured statuses (the ingest skips DONE). */
  async fetchOpenIssues(limit?: number): Promise<NormalizedIssue[]> {
    const cap = limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT;
    const nodes = await this.throttle.run(() => this.listThreads(this.config.statuses, cap));
    return nodes.map((n) => mapPlainThread(n));
  }

  /** Client-side text search over a fetched window (Plain has no server search). */
  async searchIssues(term: string, limit?: number): Promise<NormalizedIssue[]> {
    const cap = limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT;
    const needle = term.trim().toLowerCase();
    if (needle.length === 0) return [];
    const scanned = await this.throttle.run(() => this.listThreads(this.config.statuses, SEARCH_SCAN));
    const matches = scanned.filter((t) => {
      const hay = `${t.title} ${t.ref} ${t.previewText ?? ''}`.toLowerCase();
      return hay.includes(needle);
    });
    return matches.slice(0, cap).map((n) => mapPlainThread(n));
  }

  /** Resolve a thread's customer id (required for note writeback), or null if not found. */
  private async getThreadCustomerId(threadId: string): Promise<string | null> {
    const data = await this.gql<{ thread?: { id?: string | null; customer?: { id?: string | null } | null } | null }>(
      THREAD_CUSTOMER_QUERY,
      { threadId },
      `thread ${threadId}`,
    );
    const customerId = data.thread?.customer?.id;
    return customerId != null && customerId.length > 0 ? customerId : null;
  }

  /** Post an INTERNAL note on a thread (requires the thread's customer id). */
  private async addNote(threadId: string, customerId: string, body: string): Promise<void> {
    const data = await this.gql<{ createNote?: { error?: MutationError | null } | null }>(
      CREATE_NOTE_MUTATION,
      { customerId, threadId, text: body, markdown: body },
      `note on thread ${threadId}`,
    );
    this.assertNoPayloadError(data.createNote?.error, `note on thread ${threadId}`);
  }

  /** Mark a thread DONE. */
  private async markThreadDone(threadId: string): Promise<void> {
    const data = await this.gql<{ markThreadAsDone?: { error?: MutationError | null } | null }>(
      MARK_THREAD_DONE_MUTATION,
      { threadId },
      `mark thread ${threadId} done`,
    );
    this.assertNoPayloadError(data.markThreadAsDone?.error, `mark thread ${threadId} done`);
  }

  /**
   * Push a terminal task status to a Plain thread: internal note (configured or
   * default) + mark-done on completion; note-only (never marks done) on failure,
   * and only when a note is configured. NEVER sends a customer-facing reply.
   */
  async writeBack(externalId: string, status: 'completed' | 'failed'): Promise<WritebackResult> {
    const threadId = externalId.trim();
    if (threadId.length === 0) {
      return { written: false, code: 'not-found', reason: `malformed Plain id '${externalId}'` };
    }

    if (status === 'failed') {
      // `failed` writeback only fires when a note is configured (Linear/Notion
      // convention) and NEVER marks done — a failed task leaves the thread open.
      const note = this.config.statusWriteback.failed;
      if (note === undefined) {
        return { written: false, code: 'skipped', reason: "no 'failed' writeback configured" };
      }
      try {
        const customerId = await this.throttle.run(() => this.getThreadCustomerId(threadId));
        if (customerId === null) {
          return { written: false, code: 'not-found', reason: `Plain thread ${threadId} not found` };
        }
        await this.throttle.run(() => this.addNote(threadId, customerId, note));
        return { written: true, code: 'written', value: 'noted (left open)' };
      } catch (err) {
        return { written: false, code: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    }

    // completed → resolve the customer, post the note (configured or default),
    // then mark the thread done.
    const note = this.config.statusWriteback.completed ?? DEFAULT_COMPLETED_NOTE;
    try {
      const customerId = await this.throttle.run(() => this.getThreadCustomerId(threadId));
      if (customerId === null) {
        return { written: false, code: 'not-found', reason: `Plain thread ${threadId} not found` };
      }
      await this.throttle.run(() => this.addNote(threadId, customerId, note));
      await this.throttle.run(() => this.markThreadDone(threadId));
      return { written: true, code: 'written', value: 'noted + done' };
    } catch (err) {
      return { written: false, code: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Verify the API key by fetching the authenticated workspace. */
  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const ws = await this.throttle.run(() => this.fetchWorkspace());
      if (ws === null) {
        return { ok: false, detail: 'authenticated, but no workspace returned' };
      }
      return { ok: true, detail: `authenticated to workspace ${ws.name}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
