import type {
  IssueConnectorHandle,
  IssueWritebackResult,
  NormalizedIssue,
} from './issue-connector.js';
import {
  createForgejoClient,
  ForgejoApiError,
  type ForgejoClientLike,
  type ForgejoIssueNode,
} from './forgejo-client.js';
import {
  defaultForgejoConfig,
  FORGEJO_INTEGRATION,
  loadForgejoConfig,
  type ForgejoConfig,
} from './forgejo-config.js';
import { readToken } from './secrets.js';
import { RequestThrottle } from './throttle.js';

/**
 * Phase 8C.4 — the in-tree Forgejo (Gitea-compatible) Issues connector. Owns all
 * Forgejo I/O behind the injectable `ForgejoClientLike` seam; produces
 * `NormalizedIssue`s for the generic `sync_forgejo` tool across the configured
 * repos, and pushes terminal task statuses back to Forgejo issues (comment +
 * close on completion — emdash has NO Forgejo writeback at all).
 *
 * Mirrors the GitHub connector almost exactly. The external id is
 * `owner/repo#number` — the per-repo issue number (Gitea's `index`), NOT the
 * global `id`; every writeback path needs `number`.
 */

const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_COMPLETED_COMMENT = 'Completed by Symphony.';

export interface ForgejoConnectorDeps {
  readonly client: ForgejoClientLike;
  readonly config: ForgejoConfig;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Test seam: clock + sleep so unit tests don't wait on the throttle. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly minGapMs?: number;
  readonly defaultFetchLimit?: number;
}

export class ForgejoConnector implements IssueConnectorHandle {
  readonly source = FORGEJO_INTEGRATION;
  private readonly client: ForgejoClientLike;
  private readonly config: ForgejoConfig;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly throttle: RequestThrottle;
  private readonly defaultFetchLimit: number;

  constructor(deps: ForgejoConnectorDeps) {
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
    const out: NormalizedIssue[] = [];
    let firstError: unknown;
    let failures = 0;
    for (const repo of this.config.repos) {
      try {
        const nodes = await this.throttle.run(() => this.client.listOpenIssues(repo, limit));
        for (const n of nodes) out.push(this.mapIssue(n));
      } catch (err) {
        // A token that can't see one repo (404/403) must not abort the whole
        // sync — log + skip, accumulate the first error to rethrow only if EVERY
        // repo failed (so the tool surfaces a real failure, not a silent "0").
        failures += 1;
        if (firstError === undefined) firstError = err;
        this.log('warn', `${repo}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (this.config.repos.length > 0 && failures === this.config.repos.length) {
      throw firstError instanceof Error ? firstError : new Error(String(firstError));
    }
    return out;
  }

  async searchIssues(
    term: string,
    opts: { readonly limit?: number } = {},
  ): Promise<readonly NormalizedIssue[]> {
    const limit = opts.limit ?? this.defaultFetchLimit;
    const out: NormalizedIssue[] = [];
    for (const repo of this.config.repos) {
      try {
        const nodes = await this.throttle.run(() => this.client.searchIssues(term, limit, repo));
        for (const n of nodes) out.push(this.mapIssue(n));
      } catch (err) {
        this.log('warn', `${repo}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out.slice(0, limit);
  }

  private mapIssue(node: ForgejoIssueNode): NormalizedIssue {
    const title = node.title.trim();
    return {
      externalId: `${node.repo}#${node.number}`,
      title: title.length > 0 ? title : `(untitled Forgejo issue ${node.repo}#${node.number})`,
      url: node.htmlUrl.length > 0 ? node.htmlUrl : null,
      state: node.state,
      isTerminal: node.state === 'closed',
      body: node.body,
      assignee: node.assignee,
      labels: node.labels,
      // Route by the repo slug — a Symphony project named after the repo gets it.
      projectValue: node.repo.length > 0 ? node.repo : null,
      priority: forgejoLabelsToPriority(node.labels),
      updatedAt: node.updatedAt.length > 0 ? node.updatedAt : null,
    };
  }

  async writeBackStatus(
    externalId: string,
    status: 'completed' | 'failed',
  ): Promise<IssueWritebackResult> {
    const parsed = parseExternalId(externalId);
    if (parsed === undefined) {
      return { written: false, code: 'not-found', reason: `malformed Forgejo id '${externalId}'` };
    }
    const { repo, number } = parsed;

    if (status === 'failed') {
      // `failed` writeback only fires when a comment is configured (Linear/Notion
      // convention) and NEVER closes — a failed task leaves the issue open.
      const comment = this.config.statusWriteback.failed;
      if (comment === undefined) {
        return { written: false, code: 'skipped', reason: "no 'failed' writeback configured" };
      }
      try {
        await this.throttle.run(() => this.client.addComment(repo, number, comment));
        return { written: true, code: 'written', value: 'commented (left open)' };
      } catch (err) {
        return this.writebackError(err, `${repo}#${number}`);
      }
    }

    // completed → comment (configured or default) then close.
    const comment = this.config.statusWriteback.completed ?? DEFAULT_COMPLETED_COMMENT;
    try {
      await this.throttle.run(() => this.client.addComment(repo, number, comment));
      await this.throttle.run(() => this.client.closeIssue(repo, number));
      return { written: true, code: 'written', value: 'commented + closed' };
    } catch (err) {
      return this.writebackError(err, `${repo}#${number}`);
    }
  }

  private writebackError(err: unknown, ref: string): IssueWritebackResult {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof ForgejoApiError && err.status === 404) {
      return { written: false, code: 'not-found', reason: `Forgejo issue ${ref} not found` };
    }
    return { written: false, code: 'error', reason };
  }

  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const viewer = await this.throttle.run(() => this.client.getViewer());
      if (viewer === null) {
        return { ok: false, detail: 'authenticated, but no user returned' };
      }
      return { ok: true, detail: `authenticated as ${viewer.login}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Split `owner/repo#number` → `{repo, number}`, or undefined when malformed. */
function parseExternalId(externalId: string): { repo: string; number: number } | undefined {
  const hash = externalId.lastIndexOf('#');
  if (hash <= 0 || hash === externalId.length - 1) return undefined;
  const repo = externalId.slice(0, hash);
  const numStr = externalId.slice(hash + 1);
  // Strict decimal only — reject hex/exponent/whitespace forms `Number()` accepts.
  if (!repo.includes('/') || !/^[0-9]+$/.test(numStr)) return undefined;
  const num = Number(numStr);
  if (!Number.isInteger(num) || num <= 0) return undefined;
  return { repo, number: num };
}

/**
 * Forgejo has no native priority — derive an integer (higher = sooner, default 0)
 * from conventional priority labels (incl. scoped `priority/high` form). Takes
 * the HIGHEST priority across all labels. Mirrors the GitHub/GitLab/Linear scale
 * (urgent 3 / high 2 / medium 1 / low 0).
 */
export function forgejoLabelsToPriority(labels: readonly string[]): number {
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
 * Build a `ForgejoConnector` from the stored token + sidecar, or return
 * `undefined` when Forgejo isn't configured (no token, no siteUrl, or no repos).
 * Forgejo is always self-hosted, so a `siteUrl` is required in addition to a
 * token and at least one `owner/repo`.
 */
export async function createForgejoConnectorFromDisk(opts: {
  readonly home?: string;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
} = {}): Promise<ForgejoConnector | undefined> {
  const token = await readToken(FORGEJO_INTEGRATION, opts.home);
  if (token === undefined) return undefined;
  const config = (await loadForgejoConfig(opts.home)) ?? defaultForgejoConfig();
  if (config.siteUrl === undefined || config.repos.length === 0) return undefined;
  const client = createForgejoClient(token, { siteUrl: config.siteUrl });
  return new ForgejoConnector({
    client,
    config,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}
