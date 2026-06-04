import type {
  IssueConnectorHandle,
  IssueWritebackResult,
  NormalizedIssue,
} from './issue-connector.js';
import {
  createLinearClient,
  type LinearClientLike,
  type LinearIssueNode,
} from './linear-client.js';
import {
  defaultLinearConfig,
  LINEAR_INTEGRATION,
  loadLinearConfig,
  type LinearConfig,
} from './linear-config.js';
import { readToken } from './secrets.js';
import { RequestThrottle } from './throttle.js';

/**
 * Phase 8C — the in-tree Linear connector. Owns all Linear I/O behind the
 * injectable `LinearClientLike` seam; produces `NormalizedIssue`s for the
 * generic `sync_linear` tool, and pushes terminal task statuses back to Linear
 * issues by moving them to a `completed` / `canceled` workflow state.
 *
 * Like the Notion/Obsidian connectors it never touches Symphony state — task
 * creation + external-link persistence are mediated by the tool/server
 * (single-writer principle). Every API call funnels through a serialized
 * throttle (a conservative gap; our call volume is low).
 */

const LINEAR_TERMINAL_STATE_TYPES = new Set(['completed', 'canceled']);
const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
/**
 * Linear's GraphQL API hard-caps `first` at 250 and errors above it. The
 * generic `sync_issues` tool schema allows up to 500 (for connectors that
 * paginate, e.g. GitHub), so clamp here rather than fail the whole sync.
 */
const LINEAR_MAX_FIRST = 250;

export interface LinearConnectorDeps {
  readonly client: LinearClientLike;
  readonly config: LinearConfig;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Test seam: clock + sleep so unit tests don't wait on the throttle. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly minGapMs?: number;
  readonly defaultFetchLimit?: number;
}

export class LinearConnector implements IssueConnectorHandle {
  readonly source = LINEAR_INTEGRATION;
  private readonly client: LinearClientLike;
  private readonly config: LinearConfig;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly throttle: RequestThrottle;
  private readonly defaultFetchLimit: number;

  constructor(deps: LinearConnectorDeps) {
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
    const limit = Math.min(opts.limit ?? this.defaultFetchLimit, LINEAR_MAX_FIRST);
    const nodes = await this.throttle.run(() =>
      this.client.listRecentIssues(limit, this.config.teamKey),
    );
    return nodes.map((n) => this.mapIssue(n));
  }

  async searchIssues(
    term: string,
    opts: { readonly limit?: number } = {},
  ): Promise<readonly NormalizedIssue[]> {
    const limit = Math.min(opts.limit ?? this.defaultFetchLimit, LINEAR_MAX_FIRST);
    const nodes = await this.throttle.run(() => this.client.searchIssues(term, limit));
    return nodes.map((n) => this.mapIssue(n));
  }

  private mapIssue(node: LinearIssueNode): NormalizedIssue {
    const title = node.title.trim();
    return {
      externalId: node.id,
      title: title.length > 0 ? title : `(untitled Linear issue ${node.identifier})`,
      url: node.url.length > 0 ? node.url : null,
      state: node.state.name,
      isTerminal: LINEAR_TERMINAL_STATE_TYPES.has(node.state.type),
      body: node.description,
      assignee: node.assignee?.displayName ?? null,
      labels: [],
      // Route by project name first, else the team key (so a Symphony project
      // named after a Linear team/project gets the issue).
      projectValue: node.project?.name ?? node.team.key ?? null,
      priority: linearPriorityToSymphony(node.priority),
      updatedAt: node.updatedAt,
    };
  }

  async writeBackStatus(
    externalId: string,
    status: 'completed' | 'failed',
  ): Promise<IssueWritebackResult> {
    const overrideName =
      status === 'completed'
        ? this.config.statusWriteback.completed
        : this.config.statusWriteback.failed;
    // `failed` writeback only fires when a state name is configured (Notion convention).
    if (status === 'failed' && overrideName === undefined) {
      return { written: false, code: 'skipped', reason: "no 'failed' writeback configured" };
    }

    const issue = await this.throttle.run(() => this.client.getIssueWithStates(externalId));
    if (issue === null) {
      return { written: false, code: 'not-found', reason: `Linear issue ${externalId} not found` };
    }

    const targetType = status === 'completed' ? 'completed' : 'canceled';
    const target = this.resolveTargetState(issue.states, overrideName, targetType);
    if (target === undefined) {
      return {
        written: false,
        code: 'not-found',
        reason: overrideName !== undefined
          ? `no workflow state named '${overrideName}' on the issue's team`
          : `no ${targetType} workflow state on the issue's team`,
      };
    }

    const ok = await this.throttle.run(() => this.client.updateIssueState(externalId, target.id));
    if (!ok) {
      return { written: false, code: 'error', reason: 'Linear issueUpdate returned success=false' };
    }
    return { written: true, code: 'written', value: target.name };
  }

  /**
   * Resolve the workflow state to move the issue to: a configured name match
   * (case-insensitive) wins; otherwise the first state of `targetType` by
   * board position. A configured name is honored LITERALLY — it wins over
   * `targetType`, so `statusWriteback.failed: 'Done'` would move a failed task
   * to a completed-type state. That's the user's explicit choice; the auto path
   * (no override) always respects the completed/canceled type.
   */
  private resolveTargetState(
    states: readonly { id: string; name: string; type: string; position: number }[],
    overrideName: string | undefined,
    targetType: string,
  ): { id: string; name: string } | undefined {
    if (overrideName !== undefined) {
      const target = overrideName.toLowerCase();
      const byName = states.find((s) => s.name.toLowerCase() === target);
      return byName !== undefined ? { id: byName.id, name: byName.name } : undefined;
    }
    const ofType = states
      .filter((s) => s.type === targetType)
      .sort((a, b) => a.position - b.position);
    const first = ofType[0];
    return first !== undefined ? { id: first.id, name: first.name } : undefined;
  }

  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const viewer = await this.throttle.run(() => this.client.viewer());
      if (viewer === null) {
        return { ok: false, detail: 'authenticated, but no viewer returned' };
      }
      return { ok: true, detail: `authenticated as ${viewer.name}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Linear priority (0 none, 1 urgent … 4 low) → Symphony integer (higher = sooner). */
export function linearPriorityToSymphony(priority: number): number {
  return priority >= 1 && priority <= 4 ? 4 - priority : 0;
}

/**
 * Build a `LinearConnector` from the stored token + optional sidecar, or return
 * `undefined` when Linear isn't configured (no token). Linear needs no required
 * config — the API key alone activates it; `linear.json` holds optional overrides.
 */
export async function createLinearConnectorFromDisk(opts: {
  readonly home?: string;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
} = {}): Promise<LinearConnector | undefined> {
  const token = await readToken(LINEAR_INTEGRATION, opts.home);
  if (token === undefined) return undefined;
  const config = (await loadLinearConfig(opts.home)) ?? defaultLinearConfig();
  const client = createLinearClient(token);
  return new LinearConnector({
    client,
    config,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}
