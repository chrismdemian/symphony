import type {
  IssueConnectorHandle,
  IssueWritebackResult,
  NormalizedIssue,
} from './issue-connector.js';
import {
  createSentryClient,
  SentryApiError,
  type SentryClientLike,
  type SentryIssueNode,
} from './sentry-client.js';
import {
  defaultSentryConfig,
  loadSentryConfig,
  SENTRY_DEFAULT_BASE_URL,
  SENTRY_INTEGRATION,
  type SentryConfig,
} from './sentry-config.js';
import { readToken } from './secrets.js';
import { RequestThrottle } from './throttle.js';

/**
 * Phase 8D.5 — the in-tree Sentry connector. Owns all Sentry I/O behind the
 * injectable `SentryClientLike` seam; produces `NormalizedIssue`s (one per
 * unresolved error group) across the configured projects, and feeds the
 * automation trigger engine's `sentry_error` source via the shared
 * `makeIssueTriggerSource` adapter. Also serves the on-demand `sync_sentry` tool.
 *
 * Writeback diverges from the issue-tracker connectors by design: a worker that
 * INVESTIGATED a Sentry error has not necessarily FIXED it, so the default
 * writeback posts an internal NOTE and leaves the issue unresolved. Resolving is
 * opt-in (`resolveOnCompleted`) — auto-resolving an unfixed error would hide a
 * live production problem. A failed task never resolves.
 *
 * Like every connector it never touches Symphony state — task creation +
 * external-link persistence are mediated by the tool/server (single-writer
 * principle). The external id is `<project>#<numericGroupId>` — the project
 * routes to a Symphony project, the numeric group id is every writeback's key.
 */

const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
const DEFAULT_COMPLETED_NOTE = 'Investigated by Symphony.';

export interface SentryConnectorDeps {
  readonly client: SentryClientLike;
  readonly config: SentryConfig;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Test seam: clock + sleep so unit tests don't wait on the throttle. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly minGapMs?: number;
  readonly defaultFetchLimit?: number;
}

export class SentryConnector implements IssueConnectorHandle {
  readonly source = SENTRY_INTEGRATION;
  private readonly client: SentryClientLike;
  private readonly config: SentryConfig;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly throttle: RequestThrottle;
  private readonly defaultFetchLimit: number;

  constructor(deps: SentryConnectorDeps) {
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
        const nodes = await this.throttle.run(() =>
          this.client.listUnresolvedIssues(project, limit),
        );
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
        const nodes = await this.throttle.run(() =>
          this.client.searchIssues(term, limit, project),
        );
        for (const n of nodes) out.push(this.mapIssue(n));
      } catch (err) {
        this.log('warn', `${project}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return out.slice(0, limit);
  }

  private mapIssue(node: SentryIssueNode): NormalizedIssue {
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

  async writeBackStatus(
    externalId: string,
    status: 'completed' | 'failed',
  ): Promise<IssueWritebackResult> {
    const parsed = parseExternalId(externalId);
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
        await this.throttle.run(() => this.client.addNote(id, note));
        return { written: true, code: 'written', value: 'noted (left unresolved)' };
      } catch (err) {
        return this.writebackError(err, externalId);
      }
    }

    // completed → always post a note; resolve ONLY when opted in.
    const note = this.config.statusWriteback.completed ?? DEFAULT_COMPLETED_NOTE;
    try {
      await this.throttle.run(() => this.client.addNote(id, note));
      if (this.config.resolveOnCompleted) {
        await this.throttle.run(() => this.client.resolveIssue(id));
        return { written: true, code: 'written', value: 'noted + resolved' };
      }
      return { written: true, code: 'written', value: 'noted (left unresolved)' };
    } catch (err) {
      return this.writebackError(err, externalId);
    }
  }

  private writebackError(err: unknown, ref: string): IssueWritebackResult {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof SentryApiError && err.status === 404) {
      return { written: false, code: 'not-found', reason: `Sentry issue ${ref} not found` };
    }
    return { written: false, code: 'error', reason };
  }

  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    const project = this.config.projects[0];
    if (project === undefined) {
      return { ok: false, detail: 'no projects configured' };
    }
    try {
      // List-with-limit-1 verifies exactly the scope syncing needs (event:read);
      // a lighter org/viewer probe would need a scope a minimal token may lack.
      const issues = await this.throttle.run(() =>
        this.client.listUnresolvedIssues(project, 1),
      );
      return { ok: true, detail: `authenticated; reached ${this.config.org}/${project} (${issues.length} sample issue)` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Split `<project>#<numericId>` → `{project, id}`, or undefined when malformed. */
function parseExternalId(externalId: string): { project: string; id: string } | undefined {
  const hash = externalId.lastIndexOf('#');
  if (hash <= 0 || hash === externalId.length - 1) return undefined;
  const project = externalId.slice(0, hash);
  const id = externalId.slice(hash + 1);
  // Strict decimal id only — Sentry group ids are numeric strings.
  if (project.length === 0 || !/^[0-9]+$/.test(id)) return undefined;
  return { project, id };
}

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
 * Build a `SentryConnector` from the stored token + sidecar, or return
 * `undefined` when Sentry isn't configured (no token, no org, or no projects).
 */
export async function createSentryConnectorFromDisk(opts: {
  readonly home?: string;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
} = {}): Promise<SentryConnector | undefined> {
  const token = await readToken(SENTRY_INTEGRATION, opts.home);
  if (token === undefined) return undefined;
  const config = (await loadSentryConfig(opts.home)) ?? defaultSentryConfig();
  if (config.org === undefined || config.projects.length === 0) return undefined;
  const client = createSentryClient(token, {
    org: config.org,
    baseUrl: config.baseUrl ?? SENTRY_DEFAULT_BASE_URL,
  });
  return new SentryConnector({
    client,
    config,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}
