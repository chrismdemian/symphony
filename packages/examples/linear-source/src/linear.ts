import { z } from 'zod';

/**
 * linear-source — a self-contained, raw-`fetch` port of Symphony's in-tree
 * Linear connector (`src/integrations/linear.ts` + `linear-client.ts` +
 * `linear-config.ts`). A plugin can't import app internals, so the Linear I/O
 * + the issue/priority/workflow-state mapping live here as plain, testable
 * code; `index.ts` is just config-load + tool registration.
 *
 * Auth: a Linear **personal API key** is sent verbatim as the `Authorization`
 * header value (NO `Bearer` prefix — that's OAuth). The token is read from
 * `<install-dir>/config.json`, never Symphony's keychain.
 *
 * Linear's GraphQL API hard-caps `first` at 250 and errors above it; the
 * generic `sync_issues` tool allows up to 500 (for paginating connectors), so
 * the source clamps to 250 rather than failing the whole sync. Writeback moves
 * the issue to a `completed` / `canceled` workflow state.
 */

// ── config ───────────────────────────────────────────────────────────────

export const LinearSourceConfigSchema = z.object({
  /** Linear personal API key (sent verbatim as the Authorization header). */
  token: z.string().min(1),
  /** Restrict the sync to a single team by key (e.g. "ENG"). Omit for all teams. */
  teamKey: z.string().min(1).optional(),
  /**
   * Symphony terminal status → Linear workflow state NAME (writeback).
   * `completed` auto-resolves to the team's first `completed`-type state when
   * omitted; set a name to force a specific one. `failed` writeback only fires
   * when configured (omit to leave failed tasks untouched in Linear).
   */
  statusWriteback: z
    .object({
      completed: z.string().min(1).optional(),
      failed: z.string().min(1).optional(),
    })
    .default({}),
  /** Override the GraphQL endpoint (a test mock). Default api.linear.app. */
  apiUrl: z.string().url().optional(),
  /** Max issues per fetch when the caller omits `limit` (clamped to 250). */
  fetchLimit: z.number().int().min(1).max(500).optional(),
});

export type LinearSourceConfig = z.infer<typeof LinearSourceConfigSchema>;

// ── the NormalizedIssue contract (validated host-side by the adapter) ─────

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

// ── Linear GraphQL shapes ──────────────────────────────────────────────────

export interface LinearWorkflowState {
  readonly id: string;
  readonly name: string;
  /** backlog | unstarted | started | completed | canceled */
  readonly type: string;
  readonly position: number;
}

export interface LinearIssueNode {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly url: string;
  /** 0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low. */
  readonly priority: number;
  readonly updatedAt: string;
  readonly state: { readonly name: string; readonly type: string };
  readonly team: { readonly id: string; readonly key: string; readonly name: string };
  readonly project: { readonly name: string } | null;
  readonly assignee: { readonly displayName: string } | null;
}

export interface LinearIssueWithStates {
  readonly id: string;
  readonly teamId: string;
  readonly states: readonly LinearWorkflowState[];
}

export class LinearApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearApiError';
  }
}

// ── pure mapping helpers (unit-tested directly) ───────────────────────────

const LINEAR_TERMINAL_STATE_TYPES = new Set(['completed', 'canceled']);

/** Linear priority (0 none, 1 urgent … 4 low) → Symphony integer (higher = sooner). */
export function linearPriorityToSymphony(priority: number): number {
  return priority >= 1 && priority <= 4 ? 4 - priority : 0;
}

/**
 * Map a Linear issue to a `NormalizedIssue`. `isTerminal` is derived from the
 * workflow state TYPE (completed/canceled), so the host's ingest skips issues
 * already finished in Linear. The `externalId` is Linear's internal UUID
 * (`node.id`), NOT the human key (`node.identifier`) — the UUID is what every
 * writeback call needs. Pure: no I/O.
 */
export function mapLinearIssue(node: LinearIssueNode): NormalizedIssue {
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

/**
 * Resolve the workflow state to move an issue to: a configured name match
 * (case-insensitive) wins; otherwise the first state of `targetType` by board
 * position. A configured name is honored LITERALLY — it wins over `targetType`,
 * so `statusWriteback.failed: 'Done'` would move a failed task to a
 * completed-type state. That's the user's explicit choice; the auto path (no
 * override) always respects the completed/canceled type. Pure: no I/O.
 */
export function resolveTargetState(
  states: readonly LinearWorkflowState[],
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

// ── the Linear GraphQL client + connector ─────────────────────────────────

const DEFAULT_API_URL = 'https://api.linear.app/graphql';
const DEFAULT_MIN_GAP_MS = 200;
const DEFAULT_FETCH_LIMIT = 50;
/** Linear's GraphQL API hard-caps `first` at 250 and errors above it. */
const LINEAR_MAX_FIRST = 250;

const ISSUE_FIELDS = `
  id identifier title description url priority updatedAt
  state { name type }
  team { id key name }
  project { name }
  assignee { displayName }
`;

type FetchLike = typeof fetch;

/**
 * The Linear issue source. Owns all Linear I/O behind a serialized throttle.
 * `fetchImpl` is injectable so unit tests can drive it without a network.
 */
export class LinearSource {
  private readonly throttle = new RequestThrottle(DEFAULT_MIN_GAP_MS);
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;

  constructor(
    private readonly config: LinearSourceConfig,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
    this.endpoint = config.apiUrl ?? DEFAULT_API_URL;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.config.token,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new LinearApiError(
        `Linear request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new LinearApiError(`Linear API ${resp.status} ${resp.statusText}${body ? `: ${body}` : ''}`);
    }
    const json = (await resp.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
      throw new LinearApiError(`Linear GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (json.data === undefined) {
      throw new LinearApiError('Linear GraphQL response had no data');
    }
    return json.data;
  }

  /** Pull open + terminal issues (the ingest skips terminal). */
  async fetchOpenIssues(limit?: number): Promise<NormalizedIssue[]> {
    const cap = Math.min(limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT, LINEAR_MAX_FIRST);
    const filter =
      this.config.teamKey !== undefined ? { team: { key: { eq: this.config.teamKey } } } : undefined;
    const data = await this.throttle.run(() =>
      this.gql<{ issues: { nodes: LinearIssueNode[] } }>(
        `query($first: Int!, $filter: IssueFilter) {
          issues(first: $first, orderBy: updatedAt, filter: $filter) {
            nodes { ${ISSUE_FIELDS} }
          }
        }`,
        { first: cap, ...(filter !== undefined ? { filter } : {}) },
      ),
    );
    return data.issues.nodes.map((n) => mapLinearIssue(n));
  }

  /** Server-side full-text search. */
  async searchIssues(term: string, limit?: number): Promise<NormalizedIssue[]> {
    const cap = Math.min(limit ?? this.config.fetchLimit ?? DEFAULT_FETCH_LIMIT, LINEAR_MAX_FIRST);
    const data = await this.throttle.run(() =>
      this.gql<{ searchIssues: { nodes: LinearIssueNode[] } }>(
        `query($term: String!, $first: Int!) {
          searchIssues(term: $term, first: $first) {
            nodes { ${ISSUE_FIELDS} }
          }
        }`,
        { term, first: cap },
      ),
    );
    return data.searchIssues.nodes.map((n) => mapLinearIssue(n));
  }

  private async getIssueWithStates(issueId: string): Promise<LinearIssueWithStates | null> {
    const data = await this.gql<{
      issue: { id: string; team: { id: string; states: { nodes: LinearWorkflowState[] } } } | null;
    }>(
      `query($id: String!) {
        issue(id: $id) {
          id
          team { id states { nodes { id name type position } } }
        }
      }`,
      { id: issueId },
    );
    if (data.issue === null) return null;
    return {
      id: data.issue.id,
      teamId: data.issue.team.id,
      states: data.issue.team.states.nodes,
    };
  }

  private async updateIssueState(issueId: string, stateId: string): Promise<boolean> {
    const data = await this.gql<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issueId, stateId },
    );
    return data.issueUpdate.success === true;
  }

  /**
   * Push a terminal task status to a Linear issue by moving it to a
   * `completed` / `canceled` workflow state. `completed` auto-resolves the
   * target; `failed` only fires when a state name is configured.
   */
  async writeBack(externalId: string, status: 'completed' | 'failed'): Promise<WritebackResult> {
    const overrideName =
      status === 'completed' ? this.config.statusWriteback.completed : this.config.statusWriteback.failed;
    // `failed` writeback only fires when a state name is configured (Notion convention).
    if (status === 'failed' && overrideName === undefined) {
      return { written: false, code: 'skipped', reason: "no 'failed' writeback configured" };
    }
    try {
      const issue = await this.throttle.run(() => this.getIssueWithStates(externalId));
      if (issue === null) {
        return { written: false, code: 'not-found', reason: `Linear issue ${externalId} not found` };
      }
      const targetType = status === 'completed' ? 'completed' : 'canceled';
      const target = resolveTargetState(issue.states, overrideName, targetType);
      if (target === undefined) {
        return {
          written: false,
          code: 'not-found',
          reason:
            overrideName !== undefined
              ? `no workflow state named '${overrideName}' on the issue's team`
              : `no ${targetType} workflow state on the issue's team`,
        };
      }
      const ok = await this.throttle.run(() => this.updateIssueState(externalId, target.id));
      if (!ok) {
        return { written: false, code: 'error', reason: 'Linear issueUpdate returned success=false' };
      }
      return { written: true, code: 'written', value: target.name };
    } catch (err) {
      return { written: false, code: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Verify the token by fetching the authenticated user. */
  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const data = await this.throttle.run(() =>
        this.gql<{ viewer: { name: string } | null }>(`query { viewer { name } }`, {}),
      );
      if (data.viewer === null) {
        return { ok: false, detail: 'authenticated, but no viewer returned' };
      }
      return { ok: true, detail: `authenticated as ${data.viewer.name}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
