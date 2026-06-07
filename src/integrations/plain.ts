import type {
  IssueConnectorHandle,
  IssueWritebackResult,
  NormalizedIssue,
} from './issue-connector.js';
import {
  createPlainClient,
  type PlainClientLike,
  type PlainThreadNode,
} from './plain-client.js';
import {
  defaultPlainConfig,
  PLAIN_INTEGRATION,
  loadPlainConfig,
  type PlainConfig,
} from './plain-config.js';
import { readToken } from './secrets.js';
import { RequestThrottle } from './throttle.js';

/**
 * Phase 8C.4 — the in-tree Plain (customer-support) connector. Owns all Plain
 * GraphQL I/O behind the injectable `PlainClientLike` seam; produces
 * `NormalizedIssue`s for the generic `sync_plain` tool from the workspace's
 * threads, and pushes terminal task statuses back to Plain threads (internal
 * note + mark-done on completion — emdash has NO Plain writeback at all).
 *
 * The Plain entity is a THREAD; the external id is the thread `id`. Routing:
 * Plain has no Symphony-project concept, so `projectValue` is `null` — threads
 * route via the `sync_plain` `project:` arg / the active-project cursor.
 *
 * Writeback uses an INTERNAL note, never a customer-facing reply. `createNote`
 * needs the thread's `customerId`, which the client resolves via a thread
 * lookup; a missing thread surfaces as `not-found`.
 */

const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_COMPLETED_NOTE = 'Completed by Symphony.';

export interface PlainConnectorDeps {
  readonly client: PlainClientLike;
  readonly config: PlainConfig;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Test seam: clock + sleep so unit tests don't wait on the throttle. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly minGapMs?: number;
  readonly defaultFetchLimit?: number;
}

export class PlainConnector implements IssueConnectorHandle {
  readonly source = PLAIN_INTEGRATION;
  private readonly client: PlainClientLike;
  private readonly config: PlainConfig;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly throttle: RequestThrottle;
  private readonly defaultFetchLimit: number;

  constructor(deps: PlainConnectorDeps) {
    this.client = deps.client;
    this.config = deps.config;
    this.log = deps.log ?? (() => undefined);
    this.defaultFetchLimit = deps.defaultFetchLimit ?? DEFAULT_FETCH_LIMIT;
    this.throttle = new RequestThrottle(
      deps.minGapMs ?? DEFAULT_MIN_GAP_MS,
      deps.now ?? Date.now,
      deps.sleep,
    );
  }

  async fetchOpenIssues(
    opts: { readonly limit?: number } = {},
  ): Promise<readonly NormalizedIssue[]> {
    const limit = opts.limit ?? this.defaultFetchLimit;
    const nodes = await this.throttle.run(() =>
      this.client.listOpenThreads(this.config.statuses, limit),
    );
    return nodes.map((n) => this.mapThread(n));
  }

  async searchIssues(
    term: string,
    opts: { readonly limit?: number } = {},
  ): Promise<readonly NormalizedIssue[]> {
    const limit = opts.limit ?? this.defaultFetchLimit;
    const nodes = await this.throttle.run(() =>
      this.client.searchThreads(term, limit, this.config.statuses),
    );
    return nodes.map((n) => this.mapThread(n));
  }

  private mapThread(node: PlainThreadNode): NormalizedIssue {
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
      labels: node.labels,
      // Plain has no Symphony-project concept — route via the tool's `project:`
      // arg / active-project cursor (see issue-connector contract).
      projectValue: null,
      priority: plainPriorityToScore(node.priority),
      updatedAt: node.updatedAt,
    };
  }

  async writeBackStatus(
    externalId: string,
    status: 'completed' | 'failed',
  ): Promise<IssueWritebackResult> {
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
        const customerId = await this.throttle.run(() => this.client.getThreadCustomerId(threadId));
        if (customerId === null) {
          return { written: false, code: 'not-found', reason: `Plain thread ${threadId} not found` };
        }
        await this.throttle.run(() => this.client.addNote(threadId, customerId, note));
        return { written: true, code: 'written', value: 'noted (left open)' };
      } catch (err) {
        return { written: false, code: 'error', reason: err instanceof Error ? err.message : String(err) };
      }
    }

    // completed → resolve the customer, post the note (configured or default),
    // then mark the thread done.
    const note = this.config.statusWriteback.completed ?? DEFAULT_COMPLETED_NOTE;
    try {
      const customerId = await this.throttle.run(() => this.client.getThreadCustomerId(threadId));
      if (customerId === null) {
        return { written: false, code: 'not-found', reason: `Plain thread ${threadId} not found` };
      }
      await this.throttle.run(() => this.client.addNote(threadId, customerId, note));
      await this.throttle.run(() => this.client.markThreadDone(threadId));
      return { written: true, code: 'written', value: 'noted + done' };
    } catch (err) {
      return { written: false, code: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const ws = await this.throttle.run(() => this.client.getWorkspace());
      if (ws === null) {
        return { ok: false, detail: 'authenticated, but no workspace returned' };
      }
      return { ok: true, detail: `authenticated to workspace ${ws.name}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

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
 * Build a `PlainConnector` from the stored token + sidecar, or return
 * `undefined` when Plain isn't configured (no token). Like Linear, Plain
 * activates on a token alone — `plain.json` (apiUrl, statuses, writeback) is
 * optional.
 */
export async function createPlainConnectorFromDisk(opts: {
  readonly home?: string;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
} = {}): Promise<PlainConnector | undefined> {
  const token = await readToken(PLAIN_INTEGRATION, opts.home);
  if (token === undefined) return undefined;
  const config = (await loadPlainConfig(opts.home)) ?? defaultPlainConfig();
  const client = createPlainClient(token, {
    ...(config.apiUrl !== undefined ? { apiUrl: config.apiUrl } : {}),
  });
  return new PlainConnector({
    client,
    config,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}
