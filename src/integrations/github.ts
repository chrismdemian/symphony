import type {
  IssueConnectorHandle,
  IssueWritebackResult,
  NormalizedIssue,
} from './issue-connector.js';
import {
  createGitHubClient,
  GitHubApiError,
  type GitHubClientLike,
  type GitHubIssueNode,
} from './github-client.js';
import {
  defaultGitHubConfig,
  GITHUB_INTEGRATION,
  loadGitHubConfig,
  type GitHubConfig,
} from './github-config.js';
import { readToken } from './secrets.js';
import { RequestThrottle } from './throttle.js';

/**
 * Phase 8C.2 — the in-tree GitHub Issues connector. Owns all GitHub I/O behind
 * the injectable `GitHubClientLike` seam; produces `NormalizedIssue`s for the
 * generic `sync_github` tool across the configured repos, and pushes terminal
 * task statuses back to GitHub issues (comment + close on completion — the
 * differentiator over emdash, which has no GitHub writeback at all).
 *
 * Like the Linear/Notion/Obsidian connectors it never touches Symphony state —
 * task creation + external-link persistence are mediated by the tool/server
 * (single-writer principle). Every API call funnels through a serialized
 * throttle. The external id is `owner/repo#number` (the contract's documented
 * GitHub key) — it carries everything the writeback URL needs without re-parsing
 * a display URL.
 */

const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_COMPLETED_COMMENT = 'Completed by Symphony.';

export interface GitHubConnectorDeps {
  readonly client: GitHubClientLike;
  readonly config: GitHubConfig;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Test seam: clock + sleep so unit tests don't wait on the throttle. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly minGapMs?: number;
  readonly defaultFetchLimit?: number;
}

export class GitHubConnector implements IssueConnectorHandle {
  readonly source = GITHUB_INTEGRATION;
  private readonly client: GitHubClientLike;
  private readonly config: GitHubConfig;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly throttle: RequestThrottle;
  private readonly defaultFetchLimit: number;

  constructor(deps: GitHubConnectorDeps) {
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
    const nodes = await this.throttle.run(() =>
      this.client.searchIssues(term, limit, this.config.repos),
    );
    return nodes.map((n) => this.mapIssue(n));
  }

  private mapIssue(node: GitHubIssueNode): NormalizedIssue {
    const title = node.title.trim();
    return {
      externalId: `${node.repo}#${node.number}`,
      title: title.length > 0 ? title : `(untitled GitHub issue ${node.repo}#${node.number})`,
      url: node.htmlUrl.length > 0 ? node.htmlUrl : null,
      state: node.state,
      isTerminal: node.state === 'closed',
      body: node.body,
      assignee: node.assignee,
      labels: node.labels,
      // Route by the repo slug — a Symphony project named after the repo gets it.
      projectValue: node.repo.length > 0 ? node.repo : null,
      priority: githubLabelsToPriority(node.labels),
      updatedAt: node.updatedAt.length > 0 ? node.updatedAt : null,
    };
  }

  async writeBackStatus(
    externalId: string,
    status: 'completed' | 'failed',
  ): Promise<IssueWritebackResult> {
    const parsed = parseExternalId(externalId);
    if (parsed === undefined) {
      return { written: false, code: 'not-found', reason: `malformed GitHub id '${externalId}'` };
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
    if (err instanceof GitHubApiError && err.status === 404) {
      return { written: false, code: 'not-found', reason: `GitHub issue ${ref} not found` };
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
 * GitHub has no native priority — derive an integer (higher = sooner, default 0)
 * from conventional priority labels. Takes the HIGHEST priority across all
 * labels (an issue tagged both `low` and `urgent` is urgent), so the result is
 * order-independent. Matching mirrors the Linear scale (urgent 3 / high 2 /
 * medium 1 / low 0).
 */
export function githubLabelsToPriority(labels: readonly string[]): number {
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
 * Build a `GitHubConnector` from the stored token + sidecar, or return
 * `undefined` when GitHub isn't configured (no token, or no repos). Unlike
 * Linear, GitHub needs at least one `owner/repo` to know what to pull.
 */
export async function createGitHubConnectorFromDisk(opts: {
  readonly home?: string;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
} = {}): Promise<GitHubConnector | undefined> {
  const token = await readToken(GITHUB_INTEGRATION, opts.home);
  if (token === undefined) return undefined;
  const config = (await loadGitHubConfig(opts.home)) ?? defaultGitHubConfig();
  if (config.repos.length === 0) return undefined;
  const client = createGitHubClient(token, {
    ...(config.apiBaseUrl !== undefined ? { apiBaseUrl: config.apiBaseUrl } : {}),
  });
  return new GitHubConnector({
    client,
    config,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}
