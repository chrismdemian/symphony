import type { PlainThreadStatus } from './plain-config.js';

/**
 * Phase 8C.4 — narrow Plain GraphQL client seam.
 *
 * Mirrors the other connector clients: the connector talks to this interface,
 * never the raw API, so unit tests substitute a hand-written fake without any
 * network. The real impl is a thin GraphQL-over-`fetch` layer (every call is a
 * `POST` of `{ query, variables }` to the Core API endpoint).
 *
 * Auth: a Plain **API key** in `Authorization: Bearer <key>`.
 *
 * The Plain entity is a THREAD (customer-support conversation). `externalId` is
 * the thread `id`. Plain has THREE statuses (`TODO` / `SNOOZED` / `DONE`);
 * `DONE` is terminal.
 *
 * Writeback (the differentiator over emdash, which is read-only for Plain) uses
 * an INTERNAL note (`createNote`) + `markThreadAsDone` — NEVER `replyToThread`,
 * which would email the customer. `createNote` requires a `customerId`, so the
 * client resolves it via `getThreadCustomerId` (a `thread(threadId)` lookup)
 * before noting; a missing thread surfaces as `null` (→ writeback `not-found`).
 *
 * GraphQL error model: the API returns HTTP 200 with `{ errors: [...] }` for
 * query-level errors AND a per-payload `{ data: { op: { error } } }` for
 * mutation-level errors — the client inspects BOTH, plus 401/403 for auth.
 * Plain has no server-side thread text search, so `searchThreads` fetches a
 * window and filters client-side.
 */

const DEFAULT_API_URL = 'https://core-api.uk.plain.com/graphql/v1';
/** Plain caps the `threads` connection `first` argument at 100. */
const MAX_FIRST = 100;
/** Max threads scanned for a client-side text search before filtering. */
const SEARCH_SCAN = 200;

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
  /** The thread's customer id (needed for note writeback), or null. */
  readonly customerId: string | null;
  readonly labels: readonly string[];
  readonly updatedAt: string | null;
  /** App URL (workspace-scoped), or null when the workspace id is unavailable. */
  readonly url: string | null;
}

export interface PlainClientLike {
  /** Open threads in the given statuses, newest-created first (cursor-paginated). */
  listOpenThreads(
    statuses: readonly PlainThreadStatus[],
    limit: number,
  ): Promise<readonly PlainThreadNode[]>;
  /** Client-side text search over a fetched window (Plain has no server search). */
  searchThreads(
    term: string,
    limit: number,
    statuses: readonly PlainThreadStatus[],
  ): Promise<readonly PlainThreadNode[]>;
  /** Resolve a thread's customer id (for note writeback), or null if not found. */
  getThreadCustomerId(threadId: string): Promise<string | null>;
  /** Post an INTERNAL note on a thread (requires the thread's customer id). */
  addNote(threadId: string, customerId: string, body: string): Promise<void>;
  /** Mark a thread DONE. */
  markThreadDone(threadId: string): Promise<void>;
  /** Connection check — the authenticated workspace, or null. */
  getWorkspace(): Promise<{ readonly id: string; readonly name: string } | null>;
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

type FetchLike = typeof fetch;

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

/** Build a real `PlainClientLike` backed by the Plain Core GraphQL API. */
export function createPlainClient(
  token: string,
  opts: { readonly fetchImpl?: FetchLike; readonly apiUrl?: string } = {},
): PlainClientLike {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  // Cached workspace id for thread-URL construction (undefined = not yet probed,
  // null = probe failed/empty). One lazy fetch, reused for the client's lifetime.
  let workspaceIdCache: string | null | undefined;

  function headers(): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  /** Run a GraphQL operation; throw on transport, HTTP, or query-level errors. */
  async function gql<T>(
    query: string,
    variables: Record<string, unknown>,
    context: string,
  ): Promise<T> {
    let resp: Response;
    try {
      resp = await fetchImpl(apiUrl, {
        method: 'POST',
        headers: headers(),
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
  function assertNoPayloadError(error: MutationError | null | undefined, context: string): void {
    if (error !== null && error !== undefined) {
      throw new PlainApiError(`Plain ${context} failed: ${error.message ?? error.code ?? 'unknown error'}`);
    }
  }

  async function ensureWorkspaceId(): Promise<string | null> {
    if (workspaceIdCache !== undefined) return workspaceIdCache;
    try {
      const ws = await fetchWorkspace();
      workspaceIdCache = ws?.id ?? null;
    } catch {
      // A display-URL helper must never abort a list — degrade to null.
      workspaceIdCache = null;
    }
    return workspaceIdCache;
  }

  async function fetchWorkspace(): Promise<{ id: string; name: string } | null> {
    const data = await gql<{ myWorkspace?: { id?: string | null; name?: string | null } | null }>(
      MY_WORKSPACE_QUERY,
      {},
      'workspace info',
    );
    const ws = data.myWorkspace;
    if (ws?.id == null || ws.id.length === 0) return null;
    return { id: ws.id, name: ws.name ?? ws.id };
  }

  function mapThread(raw: RawThread, workspaceId: string | null): PlainThreadNode {
    const id = (raw.id ?? '').trim();
    return {
      id,
      ref: (raw.ref ?? '').trim(),
      title: (raw.title ?? '').trim(),
      previewText: raw.previewText ?? null,
      status: raw.status ?? '',
      priority: typeof raw.priority === 'number' ? raw.priority : null,
      customerId: raw.customer?.id ?? null,
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

  async function listThreads(
    statuses: readonly PlainThreadStatus[],
    limit: number,
  ): Promise<PlainThreadNode[]> {
    const workspaceId = await ensureWorkspaceId();
    const out: PlainThreadNode[] = [];
    let after: string | undefined;
    while (out.length < limit) {
      const first = Math.min(limit - out.length, MAX_FIRST);
      const data = await gql<{
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
        if (edge.node != null) out.push(mapThread(edge.node, workspaceId));
      }
      if (conn?.pageInfo?.hasNextPage !== true) break;
      const cursor = conn.pageInfo.endCursor;
      if (cursor == null || cursor.length === 0) break;
      after = cursor;
    }
    return out.slice(0, limit);
  }

  return {
    listOpenThreads(statuses, limit) {
      return listThreads(statuses, limit);
    },

    async searchThreads(term, limit, statuses) {
      const needle = term.trim().toLowerCase();
      if (needle.length === 0) return [];
      const scanned = await listThreads(statuses, SEARCH_SCAN);
      const matches = scanned.filter((t) => {
        const hay = `${t.title} ${t.ref} ${t.previewText ?? ''}`.toLowerCase();
        return hay.includes(needle);
      });
      return matches.slice(0, limit);
    },

    async getThreadCustomerId(threadId) {
      const data = await gql<{ thread?: { id?: string | null; customer?: { id?: string | null } | null } | null }>(
        THREAD_CUSTOMER_QUERY,
        { threadId },
        `thread ${threadId}`,
      );
      const customerId = data.thread?.customer?.id;
      return customerId != null && customerId.length > 0 ? customerId : null;
    },

    async addNote(threadId, customerId, body) {
      const data = await gql<{ createNote?: { error?: MutationError | null } | null }>(
        CREATE_NOTE_MUTATION,
        { customerId, threadId, text: body, markdown: body },
        `note on thread ${threadId}`,
      );
      assertNoPayloadError(data.createNote?.error, `note on thread ${threadId}`);
    },

    async markThreadDone(threadId) {
      const data = await gql<{ markThreadAsDone?: { error?: MutationError | null } | null }>(
        MARK_THREAD_DONE_MUTATION,
        { threadId },
        `mark thread ${threadId} done`,
      );
      assertNoPayloadError(data.markThreadAsDone?.error, `mark thread ${threadId} done`);
    },

    getWorkspace() {
      return fetchWorkspace();
    },
  };
}
