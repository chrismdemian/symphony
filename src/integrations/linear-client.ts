/**
 * Phase 8C — narrow Linear GraphQL client seam.
 *
 * Mirrors `notion-client.ts`: the connector talks to this interface, never the
 * raw API, so unit tests substitute a hand-written fake without any network.
 * The real impl is a thin GraphQL POST over global `fetch` (no `@linear/sdk`
 * dependency — Emdash's `LinearService.ts` proved raw GraphQL is enough).
 *
 * Auth: a Linear **personal API key** is sent verbatim as the `Authorization`
 * header value (no `Bearer` prefix). OAuth access tokens would use `Bearer`,
 * but the `symphony config linear --token` flow is for personal keys.
 */

const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

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

export interface LinearClientLike {
  /** Newest-updated issues (terminal included — the connector marks `isTerminal`
   *  and the ingest skips them). Optional `teamKey` scopes to one team. */
  listRecentIssues(limit: number, teamKey?: string): Promise<readonly LinearIssueNode[]>;
  /** Server-side full-text search. */
  searchIssues(term: string, limit: number): Promise<readonly LinearIssueNode[]>;
  /** Fetch an issue with its team's workflow states (writeback target resolution). */
  getIssueWithStates(issueId: string): Promise<LinearIssueWithStates | null>;
  /** Move an issue to a workflow state. Returns the API's `success` flag. */
  updateIssueState(issueId: string, stateId: string): Promise<boolean>;
  /** Connection check — the authenticated user's name, or null. */
  viewer(): Promise<{ readonly name: string } | null>;
}

export class LinearApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearApiError';
  }
}

const ISSUE_FIELDS = `
  id identifier title description url priority updatedAt
  state { name type }
  team { id key name }
  project { name }
  assignee { displayName }
`;

type FetchLike = typeof fetch;

/** Build a real `LinearClientLike` backed by the Linear GraphQL API. */
export function createLinearClient(
  token: string,
  opts: { readonly fetchImpl?: FetchLike } = {},
): LinearClientLike {
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let resp: Response;
    try {
      resp = await fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: token,
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

  return {
    async listRecentIssues(limit, teamKey) {
      const filter =
        teamKey !== undefined ? { team: { key: { eq: teamKey } } } : undefined;
      const data = await gql<{ issues: { nodes: LinearIssueNode[] } }>(
        `query($first: Int!, $filter: IssueFilter) {
          issues(first: $first, orderBy: updatedAt, filter: $filter) {
            nodes { ${ISSUE_FIELDS} }
          }
        }`,
        { first: limit, ...(filter !== undefined ? { filter } : {}) },
      );
      return data.issues.nodes;
    },

    async searchIssues(term, limit) {
      const data = await gql<{ searchIssues: { nodes: LinearIssueNode[] } }>(
        `query($term: String!, $first: Int!) {
          searchIssues(term: $term, first: $first) {
            nodes { ${ISSUE_FIELDS} }
          }
        }`,
        { term, first: limit },
      );
      return data.searchIssues.nodes;
    },

    async getIssueWithStates(issueId) {
      const data = await gql<{
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
    },

    async updateIssueState(issueId, stateId) {
      const data = await gql<{ issueUpdate: { success: boolean } }>(
        `mutation($id: String!, $stateId: String!) {
          issueUpdate(id: $id, input: { stateId: $stateId }) { success }
        }`,
        { id: issueId, stateId },
      );
      return data.issueUpdate.success === true;
    },

    async viewer() {
      const data = await gql<{ viewer: { name: string } | null }>(
        `query { viewer { name } }`,
        {},
      );
      return data.viewer;
    },
  };
}
