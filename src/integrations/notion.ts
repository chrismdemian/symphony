import type { TaskStatus } from '../state/types.js';
import {
  createNotionClient,
  joinRichText,
  type NotionClientLike,
  type NotionPage,
  type NotionPropertyValue,
} from './notion-client.js';
import {
  loadNotionConfig,
  mapNotionPriority,
  mapNotionStatus,
  NOTION_INTEGRATION,
  type NotionConfig,
} from './notion-config.js';
import { readToken } from './secrets.js';
import { RequestThrottle, defaultSleep } from './throttle.js';

/**
 * Phase 8A — the in-tree Notion connector. Owns all Notion I/O behind an
 * injectable client seam; produces `NotionTaskCandidate`s for the
 * `sync_notion` tool to turn into Symphony tasks, and pushes terminal task
 * statuses back to Notion pages.
 *
 * It does NOT touch Symphony state — task creation + external-link
 * persistence are mediated by the tool / server (single-writer principle:
 * Symphony observes, decides, records). The connector is pure Notion.
 *
 * Rate limit: every Notion call funnels through a serialized throttle that
 * enforces a minimum gap (default 334 ms ≈ 3 req/s, Notion's documented
 * average ceiling). The SDK separately retries 429s honoring `Retry-After`,
 * so the throttle is proactive insurance against ever hitting one.
 */

export interface NotionTaskCandidate {
  /** Notion page id — the external link key. */
  readonly pageId: string;
  /** Page URL (chat / audit display; stored on the link). */
  readonly url: string;
  /** Page title → Symphony task description. */
  readonly title: string;
  /**
   * Mapped Symphony status. Tasks are always CREATED `pending` (the store
   * forces it); this is used by the tool to SKIP pages already in a
   * terminal Notion status (don't import done work). Defaults to `pending`
   * for unmapped Notion values.
   */
  readonly status: TaskStatus;
  /** Mapped integer priority (default 0 for unmapped values). */
  readonly priority: number;
  /** Raw Notion project-property value (tool resolves to a Symphony project). */
  readonly projectValue: string | null;
}

export interface NotionWritebackResult {
  readonly written: boolean;
  /** The Notion status value written (when `written`). */
  readonly value?: string;
  /** Why nothing was written (e.g. no `failed` value configured). */
  readonly reason?: string;
}

export interface NotionConnectorHandle {
  fetchOpenPages(opts?: { readonly limit?: number }): Promise<readonly NotionTaskCandidate[]>;
  writeBackStatus(
    pageId: string,
    status: 'completed' | 'failed',
  ): Promise<NotionWritebackResult>;
}

export interface NotionConnectorDeps {
  readonly client: NotionClientLike;
  readonly config: NotionConfig;
  /** Optional structured logger (defaults to no-op — TUI owns stdout). */
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Test seam: clock + sleep so unit tests don't actually wait on the throttle. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Override the inter-request gap (default 334 ms ≈ 3 req/s). */
  readonly minGapMs?: number;
  /** Page fetch cap when `fetchOpenPages` is called without a limit. */
  readonly defaultFetchLimit?: number;
}

export class NotionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotionError';
  }
}

const DEFAULT_MIN_GAP_MS = 334;
const DEFAULT_FETCH_LIMIT = 100;
const QUERY_PAGE_SIZE = 100;

interface ResolvedSchema {
  readonly dataSourceId: string;
  /** Notion type of the status property: 'status' or 'select'. */
  readonly statusPropType: 'status' | 'select';
}

export class NotionConnector implements NotionConnectorHandle {
  private readonly client: NotionClientLike;
  private readonly config: NotionConfig;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly throttle: RequestThrottle;
  private readonly defaultFetchLimit: number;
  /** Cached after first resolve; subsequent calls reuse it. */
  private resolved: ResolvedSchema | undefined;
  private resolvePromise: Promise<ResolvedSchema> | undefined;

  constructor(deps: NotionConnectorDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.log = deps.log ?? (() => undefined);
    this.defaultFetchLimit = deps.defaultFetchLimit ?? DEFAULT_FETCH_LIMIT;
    this.throttle = new RequestThrottle(
      deps.minGapMs ?? DEFAULT_MIN_GAP_MS,
      deps.now ?? Date.now,
      deps.sleep ?? defaultSleep,
    );
  }

  /**
   * Resolve `databaseId` → `data_source_id` and learn the status property's
   * Notion type. Idempotent + memoized; concurrent callers share one
   * in-flight resolution.
   */
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
      const db = await this.throttle.run(() =>
        this.client.databases.retrieve({ database_id: this.config.databaseId }),
      );
      const sources = db.data_sources ?? [];
      if (sources.length === 0 || sources[0] === undefined) {
        throw new NotionError(
          `Notion database ${this.config.databaseId} exposes no data sources. ` +
            'Share the database with your integration and confirm it has at least one data source.',
        );
      }
      if (sources.length > 1) {
        this.log(
          'warn',
          `Notion database has ${sources.length} data sources; using the first ('${sources[0].name ?? sources[0].id}'). ` +
            'Pin `dataSourceId` in notion.json to choose another.',
        );
      }
      dataSourceId = sources[0].id;
    }

    // Learn the status property's type so writeback emits the right shape.
    const ds = await this.throttle.run(() =>
      this.client.dataSources.retrieve({ data_source_id: dataSourceId }),
    );
    const statusSchema = ds.properties?.[this.config.statusProperty];
    const statusPropType = statusSchema?.type === 'select' ? 'select' : 'status';
    if (statusSchema === undefined) {
      this.log(
        'warn',
        `Notion data source has no '${this.config.statusProperty}' property; ` +
          'writeback will assume a status-type property. Set `statusProperty` in notion.json.',
      );
    }
    return { dataSourceId, statusPropType };
  }

  async fetchOpenPages(
    opts: { readonly limit?: number } = {},
  ): Promise<readonly NotionTaskCandidate[]> {
    const limit = opts.limit ?? this.defaultFetchLimit;
    const { dataSourceId } = await this.resolveSchema();
    const out: NotionTaskCandidate[] = [];
    let cursor: string | undefined;
    // Sort newest-edited first so the cap keeps the most relevant pages.
    const sorts = [{ timestamp: 'last_edited_time', direction: 'descending' }];
    while (out.length < limit) {
      const remaining = limit - out.length;
      const resp = await this.throttle.run(() =>
        this.client.dataSources.query({
          data_source_id: dataSourceId,
          page_size: Math.min(QUERY_PAGE_SIZE, remaining),
          sorts,
          ...(cursor !== undefined ? { start_cursor: cursor } : {}),
        }),
      );
      for (const page of resp.results) {
        if (page.object !== undefined && page.object !== 'page') continue;
        out.push(this.mapPage(page));
        if (out.length >= limit) break;
      }
      if (resp.has_more !== true || !resp.next_cursor) break;
      cursor = resp.next_cursor;
    }
    return out;
  }

  /** Map a Notion page to a candidate using the configured property names + maps. */
  private mapPage(page: NotionPage): NotionTaskCandidate {
    const props = page.properties ?? {};
    const title = this.extractTitle(props);
    const statusValue = this.readStatusValue(props[this.config.statusProperty]);
    const mappedStatus =
      statusValue !== null ? mapNotionStatus(this.config, statusValue) : undefined;
    if (statusValue !== null && mappedStatus === undefined) {
      this.log('warn', `Unmapped Notion status '${statusValue}' on page ${page.id}; treating as pending.`);
    }
    const priorityValue = this.readSelectName(props[this.config.priorityProperty]);
    const mappedPriority =
      priorityValue !== null ? mapNotionPriority(this.config, priorityValue) : undefined;
    const projectValue = this.readProjectValue(props[this.config.projectProperty]);
    return {
      pageId: page.id,
      url: page.url ?? '',
      title: title.length > 0 ? title : '(untitled Notion page)',
      status: mappedStatus ?? 'pending',
      priority: mappedPriority ?? 0,
      projectValue,
    };
  }

  private extractTitle(props: Record<string, NotionPropertyValue>): string {
    for (const value of Object.values(props)) {
      if (value.type === 'title') return joinRichText(value.title).trim();
    }
    return '';
  }

  /** Read a status OR select property's option name (handles both types). */
  private readStatusValue(value: NotionPropertyValue | undefined): string | null {
    if (value === undefined) return null;
    if (value.type === 'status') return value.status?.name ?? null;
    if (value.type === 'select') return value.select?.name ?? null;
    return null;
  }

  private readSelectName(value: NotionPropertyValue | undefined): string | null {
    if (value === undefined) return null;
    if (value.type === 'select') return value.select?.name ?? null;
    if (value.type === 'status') return value.status?.name ?? null;
    return null;
  }

  /** Project routing value — select, first multi_select, or title/rich_text. */
  private readProjectValue(value: NotionPropertyValue | undefined): string | null {
    if (value === undefined) return null;
    switch (value.type) {
      case 'select':
        return value.select?.name ?? null;
      case 'status':
        return value.status?.name ?? null;
      case 'multi_select':
        return value.multi_select?.[0]?.name ?? null;
      case 'title':
        return nullIfEmpty(joinRichText(value.title));
      case 'rich_text':
        return nullIfEmpty(joinRichText(value.rich_text));
      default:
        return null;
    }
  }

  async writeBackStatus(
    pageId: string,
    status: 'completed' | 'failed',
  ): Promise<NotionWritebackResult> {
    const value =
      status === 'completed'
        ? this.config.statusWriteback.completed
        : this.config.statusWriteback.failed;
    if (value === undefined) {
      // No writeback configured for this terminal status (e.g. failed).
      return { written: false, reason: `no '${status}' writeback value configured` };
    }
    const { statusPropType } = await this.resolveSchema();
    const propertyBody =
      statusPropType === 'select'
        ? { select: { name: value } }
        : { status: { name: value } };
    await this.throttle.run(() =>
      this.client.pages.update({
        page_id: pageId,
        properties: { [this.config.statusProperty]: propertyBody },
      }),
    );
    return { written: true, value };
  }
}

function nullIfEmpty(s: string): string | null {
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build a `NotionConnector` from on-disk config + token, or return
 * `undefined` when Notion isn't configured (no `notion.json`) or has no
 * token. Used by the orchestrator server to auto-activate the connector
 * when the user has run `symphony config notion`. Throws on a present-but-
 * malformed config (via `loadNotionConfig`) — a misconfigured integration
 * must surface, not silently disable.
 */
export async function createNotionConnectorFromDisk(opts: {
  readonly home?: string;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
} = {}): Promise<NotionConnector | undefined> {
  const config = await loadNotionConfig(opts.home);
  if (config === undefined) return undefined;
  const token = await readToken(NOTION_INTEGRATION, opts.home);
  if (token === undefined) {
    opts.log?.(
      'warn',
      'Notion is configured (notion.json present) but no token is stored. Run `symphony config notion --token <token>`.',
    );
    return undefined;
  }
  const client = await createNotionClient(token);
  return new NotionConnector({
    client,
    config,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}
