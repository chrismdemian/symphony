import { z } from 'zod';

/**
 * notion-source — a self-contained, raw-`fetch` port of Symphony's in-tree
 * Notion connector (`src/integrations/notion.ts` + `notion-client.ts` +
 * `notion-config.ts`). A plugin can't import app internals, so the Notion I/O
 * + the property/status/priority mapping live here as plain, testable
 * functions; `index.ts` is just config-load + tool registration.
 *
 * Notion API v5 is the "data sources" model: a database CONTAINS data sources;
 * you resolve `databaseId` → `data_sources[0].id`, then query the DATA SOURCE.
 * The status property can be a `status` OR a `select` type, which changes the
 * writeback body shape — we learn its type once and cache it.
 */

// ── config ───────────────────────────────────────────────────────────────

/** Notion option name (compared case-insensitively) → Symphony task status. */
const StatusImportSchema = z.record(
  z.string(),
  z.enum(['pending', 'in_progress', 'completed', 'failed', 'cancelled']),
);

/** Notion option name (case-insensitive) → integer priority (higher = sooner). */
const PriorityImportSchema = z.record(z.string(), z.number().int());

export const NotionSourceConfigSchema = z.object({
  /** Notion integration token (`secret_...` / `ntn_...`). */
  token: z.string().min(1),
  /** The Notion database id Symphony points at. */
  databaseId: z.string().min(1),
  /** Resolved `data_source_id` (cached); pin to choose among multiple. */
  dataSourceId: z.string().min(1).optional(),
  /** Notion property name mapped to task status. */
  statusProperty: z.string().min(1).default('Status'),
  /** Notion property name mapped to project routing. */
  projectProperty: z.string().min(1).default('Project'),
  /** Notion property name mapped to task priority. */
  priorityProperty: z.string().min(1).default('Priority'),
  /** Notion status/select value → Symphony status (import direction). */
  statusImport: StatusImportSchema.default({
    'to do': 'pending',
    todo: 'pending',
    'not started': 'pending',
    backlog: 'pending',
    'in progress': 'in_progress',
    doing: 'in_progress',
    'in review': 'in_progress',
    done: 'completed',
    complete: 'completed',
    completed: 'completed',
  }),
  /**
   * Symphony terminal status → Notion status/select value (writeback).
   * `completed` always writes; `failed` only when configured.
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).default('Done'),
      failed: z.string().min(1).optional(),
    })
    .default({ completed: 'Done' }),
  /** Notion priority value → integer (import direction). */
  priorityImport: PriorityImportSchema.default({ high: 2, medium: 1, low: 0 }),
  /** Override the API base (GHE-style host / a test mock). Default api.notion.com. */
  apiBaseUrl: z.string().url().optional(),
  /** Max pages per fetch when the caller omits `limit`. */
  fetchLimit: z.number().int().min(1).max(500).optional(),
});

export type NotionSourceConfig = z.infer<typeof NotionSourceConfigSchema>;

// ── the NormalizedIssue contract (validated host-side by the adapter) ─────

export type SymphonyStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

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

function isTerminalSymphonyStatus(status: SymphonyStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

// ── mapping helpers (pure — unit-tested directly) ─────────────────────────

/** Case-insensitive lookup over a string-keyed record (8A audit M3 parity). */
function lookupCaseInsensitive<V>(map: Record<string, V>, value: string): V | undefined {
  const target = value.trim().toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === target) return map[key];
  }
  return undefined;
}

export function mapNotionStatus(
  config: NotionSourceConfig,
  notionValue: string,
): SymphonyStatus | undefined {
  return lookupCaseInsensitive(config.statusImport, notionValue);
}

export function mapNotionPriority(
  config: NotionSourceConfig,
  notionValue: string,
): number | undefined {
  return lookupCaseInsensitive(config.priorityImport, notionValue);
}

interface NotionRichText {
  plain_text?: string;
}
interface NotionPropertyValue {
  type?: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  status?: { name?: string } | null;
  select?: { name?: string } | null;
  multi_select?: Array<{ name?: string }>;
}
interface NotionPage {
  object?: string;
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, NotionPropertyValue>;
}

function joinRichText(parts: readonly NotionRichText[] | undefined): string {
  if (!parts) return '';
  return parts.map((p) => p.plain_text ?? '').join('');
}

function extractTitle(props: Record<string, NotionPropertyValue>): string {
  for (const value of Object.values(props)) {
    if (value.type === 'title') return joinRichText(value.title).trim();
  }
  return '';
}

/** Read a status OR select property's option name (handles both types). */
function readStatusValue(value: NotionPropertyValue | undefined): string | null {
  if (value === undefined) return null;
  if (value.type === 'status') return value.status?.name ?? null;
  if (value.type === 'select') return value.select?.name ?? null;
  return null;
}

/** Project routing value — select, first multi_select, or title/rich_text. */
function readProjectValue(value: NotionPropertyValue | undefined): string | null {
  if (value === undefined) return null;
  switch (value.type) {
    case 'select':
      return nullIfEmpty(value.select?.name ?? '');
    case 'status':
      return nullIfEmpty(value.status?.name ?? '');
    case 'multi_select':
      return nullIfEmpty(value.multi_select?.[0]?.name ?? '');
    case 'title':
      return nullIfEmpty(joinRichText(value.title));
    case 'rich_text':
      return nullIfEmpty(joinRichText(value.rich_text));
    default:
      return null;
  }
}

function nullIfEmpty(s: string): string | null {
  const t = s.trim();
  return t.length > 0 ? t : null;
}

/**
 * Map a Notion page to a `NormalizedIssue`. `isTerminal` is derived from the
 * mapped Symphony status (Done/Complete → completed → terminal), so the
 * host's ingest skips pages already finished in Notion — don't import done
 * work. Pure: no I/O, unit-tested directly.
 */
export function mapPageToIssue(config: NotionSourceConfig, page: NotionPage): NormalizedIssue {
  const props = page.properties ?? {};
  const title = extractTitle(props);
  const rawStatus = readStatusValue(props[config.statusProperty]);
  const mappedStatus = rawStatus !== null ? mapNotionStatus(config, rawStatus) : undefined;
  const status: SymphonyStatus = mappedStatus ?? 'pending';
  const rawPriority = readStatusValue(props[config.priorityProperty]);
  const mappedPriority = rawPriority !== null ? mapNotionPriority(config, rawPriority) : undefined;
  const projectValue = readProjectValue(props[config.projectProperty]);
  return {
    externalId: page.id,
    title: title.length > 0 ? title : '(untitled Notion page)',
    url: page.url !== undefined && page.url.length > 0 ? page.url : null,
    state: rawStatus,
    isTerminal: isTerminalSymphonyStatus(status),
    body: null,
    assignee: null,
    labels: [],
    projectValue,
    priority: mappedPriority ?? 0,
    updatedAt: page.last_edited_time ?? null,
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

// ── the Notion REST client + connector ────────────────────────────────────

const DEFAULT_API_BASE = 'https://api.notion.com';
const NOTION_VERSION = '2025-09-03';
const DEFAULT_MIN_GAP_MS = 334; // ≈ 3 req/s, Notion's documented average ceiling
const DEFAULT_FETCH_LIMIT = 100;
const QUERY_PAGE_SIZE = 100;

export class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}

type FetchLike = typeof fetch;

interface ResolvedSchema {
  dataSourceId: string;
  statusPropType: 'status' | 'select';
}

/**
 * The Notion issue source. Owns all Notion I/O behind a serialized throttle.
 * `fetchImpl` is injectable so unit tests can drive it without a network.
 */
export class NotionSource {
  private readonly throttle = new RequestThrottle(DEFAULT_MIN_GAP_MS);
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private resolved: ResolvedSchema | undefined;
  private resolvePromise: Promise<ResolvedSchema> | undefined;

  constructor(
    private readonly config: NotionSourceConfig,
    fetchImpl?: FetchLike,
  ) {
    this.base = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.token}`,
      'notion-version': NOTION_VERSION,
      ...extra,
    };
  }

  private async fail(resp: Response, context: string): Promise<never> {
    const body = await resp.text().catch(() => '');
    const detail = body ? `: ${body.slice(0, 300)}` : '';
    throw new NotionApiError(`Notion ${resp.status} ${resp.statusText} on ${context}${detail}`, resp.status);
  }

  /** Resolve `databaseId` → data source + learn the status property's type. */
  async resolveSchema(): Promise<ResolvedSchema> {
    if (this.resolved !== undefined) return this.resolved;
    if (this.resolvePromise === undefined) {
      this.resolvePromise = this.doResolve().then(
        (r) => {
          this.resolved = r;
          this.resolvePromise = undefined;
          return r;
        },
        (err) => {
          this.resolvePromise = undefined;
          throw err;
        },
      );
    }
    return this.resolvePromise;
  }

  private async doResolve(): Promise<ResolvedSchema> {
    let dataSourceId = this.config.dataSourceId;
    if (dataSourceId === undefined) {
      const db = await this.throttle.run(async () => {
        const resp = await this.fetchImpl(`${this.base}/v1/databases/${this.config.databaseId}`, {
          method: 'GET',
          headers: this.headers(),
        });
        if (!resp.ok) await this.fail(resp, 'retrieve database');
        return (await resp.json()) as { data_sources?: Array<{ id: string; name?: string }> };
      });
      const sources = db.data_sources ?? [];
      const first = sources[0];
      if (first === undefined) {
        throw new NotionApiError(
          `Notion database ${this.config.databaseId} exposes no data sources. ` +
            'Share the database with your integration and confirm it has at least one data source.',
        );
      }
      dataSourceId = first.id;
    }

    const ds = await this.throttle.run(async () => {
      const resp = await this.fetchImpl(`${this.base}/v1/data_sources/${dataSourceId}`, {
        method: 'GET',
        headers: this.headers(),
      });
      if (!resp.ok) await this.fail(resp, 'retrieve data source');
      return (await resp.json()) as { properties?: Record<string, { type?: string }> };
    });
    const statusSchema = ds.properties?.[this.config.statusProperty];
    const statusPropType = statusSchema?.type === 'select' ? 'select' : 'status';
    return { dataSourceId, statusPropType };
  }

  /** Fetch open + terminal pages (the ingest skips terminal). */
  async fetchOpenIssues(limit?: number): Promise<NormalizedIssue[]> {
    const cap = limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT;
    const { dataSourceId } = await this.resolveSchema();
    const out: NormalizedIssue[] = [];
    let cursor: string | undefined;
    const sorts = [{ timestamp: 'last_edited_time', direction: 'descending' }];
    while (out.length < cap) {
      const remaining = cap - out.length;
      const resp = await this.throttle.run(async () => {
        const r = await this.fetchImpl(`${this.base}/v1/data_sources/${dataSourceId}/query`, {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({
            page_size: Math.min(QUERY_PAGE_SIZE, remaining),
            sorts,
            ...(cursor !== undefined ? { start_cursor: cursor } : {}),
          }),
        });
        if (!r.ok) await this.fail(r, 'query data source');
        return (await r.json()) as {
          results: NotionPage[];
          has_more?: boolean;
          next_cursor?: string | null;
        };
      });
      for (const page of resp.results) {
        if (page.object !== undefined && page.object !== 'page') continue;
        out.push(mapPageToIssue(this.config, page));
        if (out.length >= cap) break;
      }
      if (resp.has_more !== true || !resp.next_cursor) break;
      cursor = resp.next_cursor;
    }
    return out;
  }

  /**
   * Push a terminal task status to the Notion page property. `completed`
   * always writes; `failed` only when configured. The writeback body shape
   * depends on whether the status property is a `status` or `select` type.
   */
  async writeBack(pageId: string, status: 'completed' | 'failed'): Promise<WritebackResult> {
    const value =
      status === 'completed'
        ? this.config.statusWriteback.completed
        : this.config.statusWriteback.failed;
    if (value === undefined) {
      return { written: false, code: 'skipped', reason: `no '${status}' writeback value configured` };
    }
    try {
      const { statusPropType } = await this.resolveSchema();
      const propertyBody =
        statusPropType === 'select' ? { select: { name: value } } : { status: { name: value } };
      await this.throttle.run(async () => {
        const resp = await this.fetchImpl(`${this.base}/v1/pages/${pageId}`, {
          method: 'PATCH',
          headers: this.headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ properties: { [this.config.statusProperty]: propertyBody } }),
        });
        if (!resp.ok) await this.fail(resp, `update page ${pageId}`);
        return resp;
      });
      return { written: true, code: 'written', value };
    } catch (err) {
      if (err instanceof NotionApiError && err.status === 404) {
        return { written: false, code: 'not-found', reason: `Notion page ${pageId} not found` };
      }
      return { written: false, code: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Verify the token by fetching the integration's own bot user. */
  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const resp = await this.fetchImpl(`${this.base}/v1/users/me`, {
        method: 'GET',
        headers: this.headers(),
      });
      if (!resp.ok) return { ok: false, detail: `Notion ${resp.status} ${resp.statusText}` };
      const data = (await resp.json()) as { name?: string; bot?: unknown };
      return { ok: true, detail: data.name !== undefined ? `authenticated as ${data.name}` : 'authenticated' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
