/**
 * Phase 9C.1 — unit coverage for the REAL linear-source plugin port
 * (`packages/examples/linear-source/src/linear.ts`). Drives the actual
 * `LinearSource` with an INJECTED fetch (no network) so the GraphQL fetch,
 * the `first` clamp to 250, issue→NormalizedIssue mapping, and the
 * workflow-state-resolution writeback are exercised faithfully.
 */
import { describe, expect, it } from 'vitest';

import {
  LinearSource,
  LinearSourceConfigSchema,
  mapLinearIssue,
  linearPriorityToSymphony,
  resolveTargetState,
  type LinearSourceConfig,
  type LinearIssueNode,
  type LinearWorkflowState,
} from '../../packages/examples/linear-source/src/linear.js';

function config(overrides: Partial<Record<string, unknown>> = {}): LinearSourceConfig {
  return LinearSourceConfigSchema.parse({ token: 'lin_api_x', ...overrides });
}

interface FakeResp {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): FakeResp {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

type GqlCall = { query: string; variables: Record<string, unknown> };

/**
 * A GraphQL fetch fake. `handler(query, variables)` returns the `data` payload
 * (wrapped as `{ data }` for the GraphQL envelope), or an object with an
 * `errors` key to simulate a top-level GraphQL error, or a `FakeResp` to
 * control the HTTP layer directly.
 */
function gqlFetch(
  handler: (query: string, variables: Record<string, unknown>) => unknown,
): { fetchImpl: typeof fetch; calls: GqlCall[] } {
  const calls: GqlCall[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as GqlCall;
    calls.push({ query: body.query, variables: body.variables });
    const out = handler(body.query, body.variables);
    if (out !== null && typeof out === 'object' && 'json' in (out as object)) {
      return out as unknown as Response; // FakeResp passthrough (HTTP-layer control)
    }
    if (out !== null && typeof out === 'object' && 'errors' in (out as object)) {
      return jsonResponse(out) as unknown as Response; // top-level GraphQL errors
    }
    return jsonResponse({ data: out }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const OPEN_NODE: LinearIssueNode = {
  id: '9a1b2c3d-0001',
  identifier: 'ENG-1',
  title: 'Implement the widget',
  description: 'do the thing',
  url: 'https://linear.app/acme/issue/ENG-1',
  priority: 1, // urgent → 3
  updatedAt: '2026-06-01T00:00:00Z',
  state: { name: 'In Progress', type: 'started' },
  team: { id: 't1', key: 'ENG', name: 'Engineering' },
  project: { name: 'Widgets' },
  assignee: { displayName: 'Ada' },
};
const DONE_NODE: LinearIssueNode = {
  id: '9a1b2c3d-0002',
  identifier: 'ENG-2',
  title: 'Already shipped',
  description: null,
  url: '',
  priority: 0,
  updatedAt: '2026-05-01T00:00:00Z',
  state: { name: 'Done', type: 'completed' },
  team: { id: 't1', key: 'ENG', name: 'Engineering' },
  project: null,
  assignee: null,
};

const STATES: LinearWorkflowState[] = [
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 's-prog', name: 'In Progress', type: 'started', position: 1 },
  { id: 's-done', name: 'Done', type: 'completed', position: 2 },
  { id: 's-done2', name: 'Released', type: 'completed', position: 3 },
  { id: 's-cancel', name: 'Canceled', type: 'canceled', position: 4 },
];

describe('9C.1 linear-source — pure mapping', () => {
  it('maps an issue to a NormalizedIssue (UUID id, project name route, priority inversion)', () => {
    expect(mapLinearIssue(OPEN_NODE)).toEqual({
      externalId: '9a1b2c3d-0001',
      title: 'Implement the widget',
      url: 'https://linear.app/acme/issue/ENG-1',
      state: 'In Progress',
      isTerminal: false,
      body: 'do the thing',
      assignee: 'Ada',
      labels: [],
      projectValue: 'Widgets',
      priority: 3,
      updatedAt: '2026-06-01T00:00:00Z',
    });
  });

  it('flags a completed-type issue terminal; routes by team key when no project; nulls empty url', () => {
    const issue = mapLinearIssue(DONE_NODE);
    expect(issue.isTerminal).toBe(true);
    expect(issue.projectValue).toBe('ENG');
    expect(issue.url).toBeNull();
  });

  it('untitled issue falls back to a placeholder with the identifier', () => {
    const issue = mapLinearIssue({ ...OPEN_NODE, title: '   ' });
    expect(issue.title).toBe('(untitled Linear issue ENG-1)');
  });

  it('priority inversion: none/low → 0, urgent → 3', () => {
    expect(linearPriorityToSymphony(0)).toBe(0); // none
    expect(linearPriorityToSymphony(1)).toBe(3); // urgent
    expect(linearPriorityToSymphony(2)).toBe(2); // high
    expect(linearPriorityToSymphony(4)).toBe(0); // low
    expect(linearPriorityToSymphony(99)).toBe(0); // out of range
  });

  it('resolveTargetState: auto picks the first state of the type by position; override wins by name', () => {
    expect(resolveTargetState(STATES, undefined, 'completed')).toEqual({ id: 's-done', name: 'Done' });
    expect(resolveTargetState(STATES, undefined, 'canceled')).toEqual({ id: 's-cancel', name: 'Canceled' });
    expect(resolveTargetState(STATES, 'released', 'completed')).toEqual({ id: 's-done2', name: 'Released' });
    expect(resolveTargetState(STATES, 'nope', 'completed')).toBeUndefined();
    expect(resolveTargetState([], undefined, 'completed')).toBeUndefined();
  });
});

describe('9C.1 linear-source — LinearSource I/O (injected fetch)', () => {
  it('fetchOpenIssues posts a GraphQL query with no Bearer prefix, maps nodes', async () => {
    const { fetchImpl, calls } = gqlFetch((q) =>
      q.includes('issues(first') ? { issues: { nodes: [OPEN_NODE, DONE_NODE] } } : {},
    );
    let capturedAuth: string | undefined;
    const wrapped = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>).authorization;
      return fetchImpl(url, init);
    }) as unknown as typeof fetch;
    const src = new LinearSource(config(), wrapped);
    const issues = await src.fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['9a1b2c3d-0001', '9a1b2c3d-0002']);
    expect(issues[1]!.isTerminal).toBe(true);
    // Auth header is the raw key — NO `Bearer ` prefix (that's OAuth).
    expect(capturedAuth).toBe('lin_api_x');
    expect(calls[0]!.variables.first).toBe(50); // default fetch limit
  });

  it('clamps the requested limit to Linear\'s hard cap of 250', async () => {
    const { fetchImpl, calls } = gqlFetch(() => ({ issues: { nodes: [] } }));
    const src = new LinearSource(config(), fetchImpl);
    await src.fetchOpenIssues(300);
    expect(calls[0]!.variables.first).toBe(250);
  });

  it('includes the team filter when teamKey is configured', async () => {
    const { fetchImpl, calls } = gqlFetch(() => ({ issues: { nodes: [] } }));
    const src = new LinearSource(config({ teamKey: 'ENG' }), fetchImpl);
    await src.fetchOpenIssues();
    expect(calls[0]!.variables.filter).toEqual({ team: { key: { eq: 'ENG' } } });
  });

  it('searchIssues maps the searchIssues nodes', async () => {
    const { fetchImpl } = gqlFetch((q) =>
      q.includes('searchIssues(term') ? { searchIssues: { nodes: [OPEN_NODE] } } : {},
    );
    const issues = await new LinearSource(config(), fetchImpl).searchIssues('widget');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.externalId).toBe('9a1b2c3d-0001');
  });

  it('writeBack completed → resolves the first completed-type state and updates the issue', async () => {
    const { fetchImpl, calls } = gqlFetch((q) => {
      if (q.includes('issue(id:')) return { issue: { id: 'x', team: { id: 't1', states: { nodes: STATES } } } };
      if (q.includes('issueUpdate(')) return { issueUpdate: { success: true } };
      return {};
    });
    const result = await new LinearSource(config(), fetchImpl).writeBack('9a1b2c3d-0001', 'completed');
    expect(result).toEqual({ written: true, code: 'written', value: 'Done' });
    const update = calls.find((c) => c.query.includes('issueUpdate('))!;
    expect(update.variables).toEqual({ id: '9a1b2c3d-0001', stateId: 's-done' });
  });

  it('writeBack completed honors a configured state-name override', async () => {
    const { fetchImpl, calls } = gqlFetch((q) => {
      if (q.includes('issue(id:')) return { issue: { id: 'x', team: { id: 't1', states: { nodes: STATES } } } };
      if (q.includes('issueUpdate(')) return { issueUpdate: { success: true } };
      return {};
    });
    const src = new LinearSource(config({ statusWriteback: { completed: 'Released' } }), fetchImpl);
    const result = await src.writeBack('9a1b2c3d-0001', 'completed');
    expect(result.value).toBe('Released');
    expect(calls.find((c) => c.query.includes('issueUpdate('))!.variables.stateId).toBe('s-done2');
  });

  it('writeBack failed → skipped (no API call) when not configured', async () => {
    const { fetchImpl, calls } = gqlFetch(() => ({}));
    const result = await new LinearSource(config(), fetchImpl).writeBack('9a1b2c3d-0001', 'failed');
    expect(result).toEqual({ written: false, code: 'skipped', reason: "no 'failed' writeback configured" });
    expect(calls).toHaveLength(0);
  });

  it('writeBack failed → moves to a canceled-type state when configured', async () => {
    const { fetchImpl, calls } = gqlFetch((q) => {
      if (q.includes('issue(id:')) return { issue: { id: 'x', team: { id: 't1', states: { nodes: STATES } } } };
      if (q.includes('issueUpdate(')) return { issueUpdate: { success: true } };
      return {};
    });
    const src = new LinearSource(config({ statusWriteback: { failed: 'Canceled' } }), fetchImpl);
    const result = await src.writeBack('9a1b2c3d-0001', 'failed');
    expect(result).toEqual({ written: true, code: 'written', value: 'Canceled' });
    expect(calls.find((c) => c.query.includes('issueUpdate('))!.variables.stateId).toBe('s-cancel');
  });

  it('writeBack → not-found when the issue does not exist', async () => {
    const { fetchImpl } = gqlFetch((q) => (q.includes('issue(id:') ? { issue: null } : {}));
    const result = await new LinearSource(config(), fetchImpl).writeBack('missing', 'completed');
    expect(result.code).toBe('not-found');
  });

  it('writeBack → not-found when no target workflow state exists', async () => {
    const { fetchImpl } = gqlFetch((q) =>
      q.includes('issue(id:') ? { issue: { id: 'x', team: { id: 't1', states: { nodes: [] } } } } : {},
    );
    const result = await new LinearSource(config(), fetchImpl).writeBack('9a1b2c3d-0001', 'completed');
    expect(result.code).toBe('not-found');
  });

  it('writeBack → error when issueUpdate returns success=false', async () => {
    const { fetchImpl } = gqlFetch((q) => {
      if (q.includes('issue(id:')) return { issue: { id: 'x', team: { id: 't1', states: { nodes: STATES } } } };
      if (q.includes('issueUpdate(')) return { issueUpdate: { success: false } };
      return {};
    });
    const result = await new LinearSource(config(), fetchImpl).writeBack('9a1b2c3d-0001', 'completed');
    expect(result).toEqual({ written: false, code: 'error', reason: 'Linear issueUpdate returned success=false' });
  });

  it('writeBack → error (caught) on a GraphQL error', async () => {
    const { fetchImpl } = gqlFetch(() => ({ errors: [{ message: 'boom' }] }));
    const result = await new LinearSource(config(), fetchImpl).writeBack('9a1b2c3d-0001', 'completed');
    expect(result.code).toBe('error');
    expect(result.reason).toContain('boom');
  });

  it('checkConnection reports the viewer name', async () => {
    const { fetchImpl } = gqlFetch((q) => (q.includes('viewer') ? { viewer: { name: 'Ada Lovelace' } } : {}));
    const result = await new LinearSource(config(), fetchImpl).checkConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('Ada Lovelace');
  });
});
