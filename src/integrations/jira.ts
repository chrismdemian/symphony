import type {
  IssueConnectorHandle,
  IssueWritebackResult,
  NormalizedIssue,
} from './issue-connector.js';
import {
  createJiraClient,
  JiraApiError,
  type JiraClientLike,
  type JiraIssueNode,
} from './jira-client.js';
import {
  JIRA_INTEGRATION,
  loadJiraConfig,
  type JiraConfig,
} from './jira-config.js';
import { readToken } from './secrets.js';
import { RequestThrottle } from './throttle.js';

/**
 * Phase 8C.3 — the in-tree Jira Issues connector. Owns all Jira I/O behind the
 * injectable `JiraClientLike` seam; produces `NormalizedIssue`s for the generic
 * `sync_jira` tool, and pushes terminal task statuses back to Jira issues
 * (comment + transition to a Done-category state on completion — emdash has NO
 * Jira writeback at all, the differentiator).
 *
 * The fetch uses a JQL FALLBACK CHAIN (ported from emdash `JiraService.ts:117-153`,
 * adapted to the new bounded-query enhanced-search endpoint): a permission-scoped
 * token that can't browse all projects still gets its assigned/reported issues,
 * and a token that can't run JQL at all falls back to the issue-picker history.
 * Each candidate is tried in order; the first that returns rows wins; errors
 * (e.g. 403 on an unbrowsable project) fall through to the next candidate.
 *
 * The external id is the issue KEY (`ENG-123`) — stable, human-readable, and the
 * direct writeback target.
 */

const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_COMPLETED_COMMENT = 'Completed by Symphony.';
/** Every fetch candidate is anchored on this clause so it stays a bounded query
 *  (the enhanced-search endpoint rejects fully-unbounded JQL) AND skips done
 *  work at the source — the same open-only posture as the GitHub connector. */
const NOT_DONE = 'statusCategory != Done';

export interface JiraConnectorDeps {
  readonly client: JiraClientLike;
  readonly config: JiraConfig;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Test seam: clock + sleep so unit tests don't wait on the throttle. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly minGapMs?: number;
  readonly defaultFetchLimit?: number;
}

export class JiraConnector implements IssueConnectorHandle {
  readonly source = JIRA_INTEGRATION;
  private readonly client: JiraClientLike;
  private readonly config: JiraConfig;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly throttle: RequestThrottle;
  private readonly defaultFetchLimit: number;

  constructor(deps: JiraConnectorDeps) {
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

  async fetchOpenIssues(
    opts: { readonly limit?: number } = {},
  ): Promise<readonly NormalizedIssue[]> {
    const limit = opts.limit ?? this.defaultFetchLimit;

    for (const jql of this.jqlCandidates()) {
      try {
        const nodes = await this.throttle.run(() => this.client.searchByJql(jql, limit));
        if (nodes.length > 0) return nodes.map((n) => this.mapIssue(n));
      } catch (err) {
        // Forbidden / unbrowsable project → try the next, narrower candidate.
        this.log('warn', `jql "${jql}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Final fallback: the issue-picker history (permission-blind), hydrated per
    // key. Returns ALL statuses, so `isTerminal` (statusCategory === 'done')
    // earns its keep here — the ingest skips the done ones.
    try {
      const keys = await this.throttle.run(() => this.client.getRecentIssueKeys(limit));
      const out: NormalizedIssue[] = [];
      for (const key of keys.slice(0, limit)) {
        try {
          const node = await this.throttle.run(() => this.client.getIssue(key));
          if (node !== null) out.push(this.mapIssue(node));
        } catch {
          // Skip an individual issue we can't read.
        }
      }
      return out;
    } catch (err) {
      this.log('warn', `issue-picker fallback failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async searchIssues(
    term: string,
    opts: { readonly limit?: number } = {},
  ): Promise<readonly NormalizedIssue[]> {
    const limit = opts.limit ?? this.defaultFetchLimit;
    const sanitized = term.replace(/"/g, '\\"');
    const jql = `text ~ "${sanitized}" ORDER BY updated DESC`;
    const nodes = await this.throttle.run(() => this.client.searchByJql(jql, limit));
    return nodes.map((n) => this.mapIssue(n));
  }

  private mapIssue(node: JiraIssueNode): NormalizedIssue {
    const title = node.summary.trim();
    return {
      externalId: node.key,
      title: title.length > 0 ? title : `(untitled Jira issue ${node.key})`,
      url: node.webUrl.length > 0 ? node.webUrl : null,
      state: node.statusName,
      isTerminal: node.statusCategoryKey === 'done',
      body: node.description,
      assignee: node.assignee,
      labels: node.labels,
      // Route by the project key — a Symphony project named after it gets it.
      projectValue: node.projectKey !== null && node.projectKey.length > 0 ? node.projectKey : null,
      priority: jiraPriorityToSymphony(node.priorityName),
      updatedAt: node.updatedAt,
    };
  }

  async writeBackStatus(
    externalId: string,
    status: 'completed' | 'failed',
  ): Promise<IssueWritebackResult> {
    const key = externalId.trim();
    if (key.length === 0) {
      return { written: false, code: 'not-found', reason: `empty Jira key '${externalId}'` };
    }

    if (status === 'failed') {
      // `failed` writeback only fires when a comment is configured (Linear/Notion
      // convention) and NEVER transitions — a failed task leaves the issue where
      // it is for a human.
      const comment = this.config.statusWriteback.failed;
      if (comment === undefined) {
        return { written: false, code: 'skipped', reason: "no 'failed' writeback configured" };
      }
      try {
        await this.throttle.run(() => this.client.addComment(key, comment));
        return { written: true, code: 'written', value: 'commented (no transition)' };
      } catch (err) {
        return this.writebackError(err, key);
      }
    }

    // completed → comment (configured or default) then transition to Done.
    const comment = this.config.statusWriteback.completed ?? DEFAULT_COMPLETED_COMMENT;
    try {
      await this.throttle.run(() => this.client.addComment(key, comment));
    } catch (err) {
      return this.writebackError(err, key);
    }

    // Resolve the target transition: the configured name override wins; else the
    // first transition whose TARGET status is in the Done category.
    let transitions;
    try {
      transitions = await this.throttle.run(() => this.client.getTransitions(key));
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
      // couldn't be resolved — report `written: false` so the hook surfaces the
      // reason as a warning. `written: true` would log a plain success and drop
      // the reason (issue-writeback.ts branches on `written` first). The Done
      // target state couldn't be resolved → `not-found` per the contract.
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
      await this.throttle.run(() => this.client.transitionIssue(key, target.id));
      return { written: true, code: 'written', value: `commented + transitioned to '${target.name}'` };
    } catch (err) {
      return this.writebackError(err, key);
    }
  }

  private writebackError(err: unknown, ref: string): IssueWritebackResult {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof JiraApiError && err.status === 404) {
      return { written: false, code: 'not-found', reason: `Jira issue ${ref} not found` };
    }
    return { written: false, code: 'error', reason };
  }

  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const me = await this.throttle.run(() => this.client.getMyself());
      if (me === null) {
        return { ok: false, detail: 'authenticated, but no user returned' };
      }
      return { ok: true, detail: `authenticated as ${me.displayName}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Map a Jira priority name to a Symphony integer (higher = sooner, default 0),
 * on the same 0-3 scale as the GitHub/Linear connectors. Jira's standard scheme
 * is Highest / High / Medium / Low / Lowest; anything unrecognized → 0.
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

/**
 * Build a `JiraConnector` from the stored token + sidecar, or return `undefined`
 * when Jira isn't configured. Jira Basic auth needs BOTH a `siteUrl` and an
 * `email` (alongside the keychain token) to activate.
 */
export async function createJiraConnectorFromDisk(opts: {
  readonly home?: string;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
} = {}): Promise<JiraConnector | undefined> {
  const token = await readToken(JIRA_INTEGRATION, opts.home);
  if (token === undefined) return undefined;
  const config = await loadJiraConfig(opts.home);
  if (config?.siteUrl === undefined || config.email === undefined) return undefined;
  const client = createJiraClient({ siteUrl: config.siteUrl, email: config.email, token });
  return new JiraConnector({
    client,
    config,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}
