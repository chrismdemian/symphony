import type {
  IssueConnectorHandle,
  IssueWritebackResult,
  NormalizedIssue,
} from './issue-connector.js';
import {
  createGitLabClient,
  GitLabApiError,
  type GitLabClientLike,
  type GitLabIssueNode,
} from './gitlab-client.js';
import {
  defaultGitLabConfig,
  GITLAB_INTEGRATION,
  loadGitLabConfig,
  type GitLabConfig,
} from './gitlab-config.js';
import { readToken } from './secrets.js';
import { RequestThrottle } from './throttle.js';

/**
 * Phase 8C.3 — the in-tree GitLab Issues connector. Owns all GitLab I/O behind
 * the injectable `GitLabClientLike` seam; produces `NormalizedIssue`s for the
 * generic `sync_gitlab` tool across the configured projects, and pushes terminal
 * task statuses back to GitLab issues (note + close on completion — emdash has
 * NO GitLab writeback at all).
 *
 * Mirrors the GitHub connector almost exactly. The external id is
 * `group/project#iid` — the per-project issue number (`iid`), NOT the global
 * `id`; every writeback path needs `iid`.
 */

const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_COMPLETED_NOTE = 'Completed by Symphony.';

export interface GitLabConnectorDeps {
  readonly client: GitLabClientLike;
  readonly config: GitLabConfig;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Test seam: clock + sleep so unit tests don't wait on the throttle. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly minGapMs?: number;
  readonly defaultFetchLimit?: number;
}

export class GitLabConnector implements IssueConnectorHandle {
  readonly source = GITLAB_INTEGRATION;
  private readonly client: GitLabClientLike;
  private readonly config: GitLabConfig;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly throttle: RequestThrottle;
  private readonly defaultFetchLimit: number;

  constructor(deps: GitLabConnectorDeps) {
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
    for (const project of this.config.projects) {
      try {
        const nodes = await this.throttle.run(() => this.client.listOpenIssues(project, limit));
        for (const n of nodes) out.push(this.mapIssue(n));
      } catch (err) {
        // A token that can't see one project (404/403) must not abort the whole
        // sync — log + skip, accumulate the first error to rethrow only if EVERY
        // project failed (so the tool surfaces a real failure, not a silent "0").
        failures += 1;
        if (firstError === undefined) firstError = err;
        this.log('warn', `${project}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (this.config.projects.length > 0 && failures === this.config.projects.length) {
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
    for (const project of this.config.projects) {
      try {
        const nodes = await this.throttle.run(() => this.client.searchIssues(term, limit, project));
        for (const n of nodes) out.push(this.mapIssue(n));
      } catch (err) {
        this.log('warn', `${project}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out.slice(0, limit);
  }

  private mapIssue(node: GitLabIssueNode): NormalizedIssue {
    const title = node.title.trim();
    return {
      externalId: `${node.projectPath}#${node.iid}`,
      title:
        title.length > 0 ? title : `(untitled GitLab issue ${node.projectPath}#${node.iid})`,
      url: node.webUrl.length > 0 ? node.webUrl : null,
      state: node.state,
      isTerminal: node.state === 'closed',
      body: node.body,
      assignee: node.assignee,
      labels: node.labels,
      // Route by the project path — a Symphony project named after it gets it.
      projectValue: node.projectPath.length > 0 ? node.projectPath : null,
      priority: gitlabLabelsToPriority(node.labels),
      updatedAt: node.updatedAt.length > 0 ? node.updatedAt : null,
    };
  }

  async writeBackStatus(
    externalId: string,
    status: 'completed' | 'failed',
  ): Promise<IssueWritebackResult> {
    const parsed = parseExternalId(externalId);
    if (parsed === undefined) {
      return { written: false, code: 'not-found', reason: `malformed GitLab id '${externalId}'` };
    }
    const { projectPath, iid } = parsed;

    if (status === 'failed') {
      // `failed` writeback only fires when a note is configured (Linear/Notion
      // convention) and NEVER closes — a failed task leaves the issue open.
      const note = this.config.statusWriteback.failed;
      if (note === undefined) {
        return { written: false, code: 'skipped', reason: "no 'failed' writeback configured" };
      }
      try {
        await this.throttle.run(() => this.client.addNote(projectPath, iid, note));
        return { written: true, code: 'written', value: 'noted (left open)' };
      } catch (err) {
        return this.writebackError(err, `${projectPath}#${iid}`);
      }
    }

    // completed → note (configured or default) then close.
    const note = this.config.statusWriteback.completed ?? DEFAULT_COMPLETED_NOTE;
    try {
      await this.throttle.run(() => this.client.addNote(projectPath, iid, note));
      await this.throttle.run(() => this.client.closeIssue(projectPath, iid));
      return { written: true, code: 'written', value: 'noted + closed' };
    } catch (err) {
      return this.writebackError(err, `${projectPath}#${iid}`);
    }
  }

  private writebackError(err: unknown, ref: string): IssueWritebackResult {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof GitLabApiError && err.status === 404) {
      return { written: false, code: 'not-found', reason: `GitLab issue ${ref} not found` };
    }
    return { written: false, code: 'error', reason };
  }

  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const viewer = await this.throttle.run(() => this.client.getViewer());
      if (viewer === null) {
        return { ok: false, detail: 'authenticated, but no user returned' };
      }
      return { ok: true, detail: `authenticated as ${viewer.username}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Split `group/project#iid` → `{projectPath, iid}`, or undefined when malformed.
 * The project path may itself contain `/` (subgroups), so we split on the LAST
 * `#` (a path segment can't contain `#`).
 */
function parseExternalId(externalId: string): { projectPath: string; iid: number } | undefined {
  const hash = externalId.lastIndexOf('#');
  if (hash <= 0 || hash === externalId.length - 1) return undefined;
  const projectPath = externalId.slice(0, hash);
  const iidStr = externalId.slice(hash + 1);
  // Strict decimal only — reject hex/exponent/whitespace forms `Number()` accepts.
  if (!projectPath.includes('/') || !/^[0-9]+$/.test(iidStr)) return undefined;
  const iid = Number(iidStr);
  if (!Number.isInteger(iid) || iid <= 0) return undefined;
  return { projectPath, iid };
}

/**
 * GitLab has no native priority — derive an integer (higher = sooner, default 0)
 * from conventional priority labels (incl. scoped `priority::high` form). Takes
 * the HIGHEST priority across all labels. Mirrors the GitHub/Linear scale
 * (urgent 3 / high 2 / medium 1 / low 0).
 */
export function gitlabLabelsToPriority(labels: readonly string[]): number {
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
 * Build a `GitLabConnector` from the stored token + sidecar, or return
 * `undefined` when GitLab isn't configured (no token, or no projects). Like
 * GitHub, GitLab needs at least one `group/project` to know what to pull.
 */
export async function createGitLabConnectorFromDisk(opts: {
  readonly home?: string;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
} = {}): Promise<GitLabConnector | undefined> {
  const token = await readToken(GITLAB_INTEGRATION, opts.home);
  if (token === undefined) return undefined;
  const config = (await loadGitLabConfig(opts.home)) ?? defaultGitLabConfig();
  if (config.projects.length === 0) return undefined;
  const client = createGitLabClient(token, {
    ...(config.siteUrl !== undefined ? { siteUrl: config.siteUrl } : {}),
  });
  return new GitLabConnector({
    client,
    config,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}
