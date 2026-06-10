/**
 * Phase 9C.3 — unit coverage for the REAL plain-source plugin port
 * (`packages/examples/plain-source/src/plain.ts`). Drives the actual
 * `PlainSource` with an INJECTED fetch (no network) so the Bearer auth, the
 * thread-id externalId, cursor pagination, the HTTP-200-always GraphQL error
 * model (both `errors[]` and mutation-payload `{error}`), client-side search,
 * and the internal-note + mark-done writeback are exercised faithfully.
 *
 * The load-bearing footgun: writeback is NEVER a customer-facing reply — only
 * `createNote` (after a customerId lookup) + `markThreadAsDone`. The final test
 * asserts `replyToThread` is never sent.
 */
import { describe, expect, it } from 'vitest';

import {
  PlainSource,
  PlainSourceConfigSchema,
  mapPlainThread,
  plainPriorityToScore,
  type PlainSourceConfig,
  type PlainThreadNode,
} from '../../packages/examples/plain-source/src/plain.js';

function config(overrides: Partial<Record<string, unknown>> = {}): PlainSourceConfig {
  return PlainSourceConfigSchema.parse({ token: 'plain_x', ...overrides });
}

interface GqlCall {
  query: string;
  variables: Record<string, unknown>;
  headers: Record<string, string>;
}
interface GqlResp {
  status?: number;
  data?: unknown;
  errors?: Array<{ message?: string }>;
}

function opName(query: string): string {
  if (query.includes('MyWorkspace')) return 'workspace';
  if (query.includes('ListThreads')) return 'list';
  if (query.includes('ThreadCustomer')) return 'customer';
  if (query.includes('CreateNote')) return 'note';
  if (query.includes('MarkThreadAsDone')) return 'done';
  return 'unknown';
}

/** A GraphQL fetch fake: `handler(op, vars)` returns a response spec; calls captured. */
function makeGqlFetch(
  handler: (op: string, vars: Record<string, unknown>, query: string) => GqlResp | undefined,
): { fetchImpl: typeof fetch; calls: GqlCall[] } {
  const calls: GqlCall[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = String(body.query ?? '');
    const variables = body.variables ?? {};
    calls.push({ query, variables, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = handler(opName(query), variables, query) ?? {};
    const status = r.status ?? 200;
    const payload = { data: r.data ?? null, errors: r.errors };
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function rawThread(
  id: string,
  status = 'TODO',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    ref: `T-${id}`,
    title: `Thread ${id}`,
    previewText: 'preview body',
    status,
    priority: 1,
    customer: { id: `cust-${id}` },
    labels: [{ labelType: { name: 'billing' } }],
    updatedAt: { iso8601: '2026-06-01T00:00:00Z' },
    ...overrides,
  };
}

/** Default handler: workspace + a one-page list of the given raws. */
function listOf(raws: Record<string, unknown>[]): (op: string) => GqlResp | undefined {
  return (op) => {
    if (op === 'workspace') return { data: { myWorkspace: { id: 'ws1', name: 'Acme' } } };
    if (op === 'list') {
      return {
        data: {
          threads: { edges: raws.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } },
        },
      };
    }
    return { data: {} };
  };
}

const NODE: PlainThreadNode = {
  id: 'th-1',
  ref: 'T-747',
  title: 'Refund request',
  previewText: 'customer wants a refund',
  status: 'TODO',
  priority: 0,
  labels: ['billing'],
  updatedAt: '2026-06-01T00:00:00Z',
  url: 'https://app.plain.com/workspace/ws1/thread/th-1',
};

describe('9C.3 plain-source — pure mapping', () => {
  it('maps a thread to a NormalizedIssue (thread id externalId, projectValue null, priority inversion)', () => {
    expect(mapPlainThread(NODE)).toEqual({
      externalId: 'th-1',
      title: 'Refund request',
      url: 'https://app.plain.com/workspace/ws1/thread/th-1',
      state: 'TODO',
      isTerminal: false,
      body: 'customer wants a refund',
      assignee: null,
      labels: ['billing'],
      projectValue: null,
      priority: 3, // urgent(0) → 3
      updatedAt: '2026-06-01T00:00:00Z',
    });
  });

  it('flags a DONE thread terminal', () => {
    expect(mapPlainThread({ ...NODE, status: 'DONE' }).isTerminal).toBe(true);
    expect(mapPlainThread({ ...NODE, status: 'SNOOZED' }).isTerminal).toBe(false);
  });

  it('untitled thread falls back to a placeholder with the ref', () => {
    expect(mapPlainThread({ ...NODE, title: '   ' }).title).toBe('(untitled Plain thread T-747)');
    // No ref → falls back to the id.
    expect(mapPlainThread({ ...NODE, title: '', ref: '' }).title).toBe('(untitled Plain thread th-1)');
  });

  it('plainPriorityToScore inverts Plain priority (0=urgent → 3), clamps unknowns to 0', () => {
    expect(plainPriorityToScore(0)).toBe(3);
    expect(plainPriorityToScore(1)).toBe(2);
    expect(plainPriorityToScore(2)).toBe(1);
    expect(plainPriorityToScore(3)).toBe(0);
    expect(plainPriorityToScore(null)).toBe(0);
    expect(plainPriorityToScore(9)).toBe(0); // out of range
    expect(plainPriorityToScore(1.5)).toBe(0); // non-integer
  });
});

describe('9C.3 plain-source — PlainSource I/O (injected fetch)', () => {
  it('fetchOpenIssues sends Bearer auth, the TODO status filter, maps nodes + builds URLs', async () => {
    const { fetchImpl, calls } = makeGqlFetch(listOf([rawThread('1'), rawThread('2', 'DONE')]));
    const issues = await new PlainSource(config(), fetchImpl).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['1', '2']);
    expect(issues[1]!.isTerminal).toBe(true);
    expect(issues[0]!.projectValue).toBeNull();
    expect(issues[0]!.url).toBe('https://app.plain.com/workspace/ws1/thread/1');
    const listCall = calls.find((c) => opName(c.query) === 'list')!;
    expect(listCall.headers.authorization).toBe('Bearer plain_x');
    expect(listCall.variables.statuses).toEqual(['TODO']); // default status filter
  });

  it('honors a custom statuses filter', async () => {
    const { fetchImpl, calls } = makeGqlFetch(listOf([rawThread('1')]));
    await new PlainSource(config({ statuses: ['TODO', 'SNOOZED'] }), fetchImpl).fetchOpenIssues();
    const listCall = calls.find((c) => opName(c.query) === 'list')!;
    expect(listCall.variables.statuses).toEqual(['TODO', 'SNOOZED']);
  });

  it('cursor pagination: follows pageInfo.endCursor while hasNextPage', async () => {
    let page = 0;
    const { fetchImpl, calls } = makeGqlFetch((op) => {
      if (op === 'workspace') return { data: { myWorkspace: { id: 'ws1', name: 'Acme' } } };
      if (op === 'list') {
        page += 1;
        if (page === 1) {
          return {
            data: {
              threads: {
                edges: [rawThread('1'), rawThread('2')].map((node) => ({ node })),
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              },
            },
          };
        }
        return {
          data: {
            threads: {
              edges: [{ node: rawThread('3') }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }
      return { data: {} };
    });
    const issues = await new PlainSource(config(), fetchImpl).fetchOpenIssues(3);
    expect(issues.map((i) => i.externalId)).toEqual(['1', '2', '3']);
    const listCalls = calls.filter((c) => opName(c.query) === 'list');
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]!.variables.after).toBe('cursor-1'); // page 2 sent the cursor
  });

  it('GraphQL query-level errors throw (HTTP 200 + errors[])', async () => {
    const { fetchImpl } = makeGqlFetch((op) => {
      if (op === 'workspace') return { data: { myWorkspace: { id: 'ws1', name: 'Acme' } } };
      if (op === 'list') return { errors: [{ message: 'bad query' }] };
      return { data: {} };
    });
    await expect(new PlainSource(config(), fetchImpl).fetchOpenIssues()).rejects.toThrow(/bad query/);
  });

  it('401 throws an auth error', async () => {
    const { fetchImpl } = makeGqlFetch(() => ({ status: 401 }));
    await expect(new PlainSource(config(), fetchImpl).fetchOpenIssues()).rejects.toThrow(/auth failed \(401\)/);
  });

  it('searchIssues filters the scanned window client-side (Plain has no server search)', async () => {
    const { fetchImpl } = makeGqlFetch(
      listOf([
        rawThread('1', 'TODO', { title: 'Refund the widget', previewText: '' }),
        rawThread('2', 'TODO', { title: 'Unrelated', previewText: 'nothing here' }),
      ]),
    );
    const issues = await new PlainSource(config(), fetchImpl).searchIssues('refund');
    expect(issues.map((i) => i.externalId)).toEqual(['1']);
  });

  it('searchIssues with an empty term returns nothing (no fetch)', async () => {
    const { fetchImpl, calls } = makeGqlFetch(listOf([rawThread('1')]));
    const issues = await new PlainSource(config(), fetchImpl).searchIssues('   ');
    expect(issues).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('writeBack completed → customer lookup, then createNote, then markThreadAsDone (in order)', async () => {
    const { fetchImpl, calls } = makeGqlFetch((op) => {
      if (op === 'customer') return { data: { thread: { id: 'th-9', customer: { id: 'cust-9' } } } };
      if (op === 'note') return { data: { createNote: { note: { id: 'n1' }, error: null } } };
      if (op === 'done') return { data: { markThreadAsDone: { thread: { id: 'th-9' }, error: null } } };
      return { data: {} };
    });
    const result = await new PlainSource(config(), fetchImpl).writeBack('th-9', 'completed');
    expect(result).toEqual({ written: true, code: 'written', value: 'noted + done' });
    expect(calls.map((c) => opName(c.query))).toEqual(['customer', 'note', 'done']);
    const noteCall = calls.find((c) => opName(c.query) === 'note')!;
    expect(noteCall.variables.customerId).toBe('cust-9');
    expect(noteCall.variables.text).toBe('Completed by Symphony.');
  });

  it('writeBack completed honors a configured note', async () => {
    const { fetchImpl, calls } = makeGqlFetch((op) => {
      if (op === 'customer') return { data: { thread: { id: 'th-9', customer: { id: 'cust-9' } } } };
      if (op === 'note') return { data: { createNote: { error: null } } };
      if (op === 'done') return { data: { markThreadAsDone: { error: null } } };
      return { data: {} };
    });
    const src = new PlainSource(config({ statusWriteback: { completed: 'resolved ✅' } }), fetchImpl);
    await src.writeBack('th-9', 'completed');
    expect(calls.find((c) => opName(c.query) === 'note')!.variables.text).toBe('resolved ✅');
  });

  it('writeBack completed → not-found when the thread has no customer (null)', async () => {
    const { fetchImpl, calls } = makeGqlFetch((op) => {
      if (op === 'customer') return { data: { thread: null } }; // thread not found
      return { data: {} };
    });
    const result = await new PlainSource(config(), fetchImpl).writeBack('th-gone', 'completed');
    expect(result.code).toBe('not-found');
    // No note/done attempted once the customer lookup failed.
    expect(calls.map((c) => opName(c.query))).toEqual(['customer']);
  });

  it('writeBack completed → error on a mutation-payload error (HTTP 200 + {error})', async () => {
    const { fetchImpl } = makeGqlFetch((op) => {
      if (op === 'customer') return { data: { thread: { id: 'th-9', customer: { id: 'cust-9' } } } };
      if (op === 'note') return { data: { createNote: { error: { message: 'note rejected', code: 'X' } } } };
      return { data: {} };
    });
    const result = await new PlainSource(config(), fetchImpl).writeBack('th-9', 'completed');
    expect(result.code).toBe('error');
    expect(result.reason).toContain('note rejected');
  });

  it('writeBack failed → skipped (no calls) when not configured', async () => {
    const { fetchImpl, calls } = makeGqlFetch(() => ({ data: {} }));
    const result = await new PlainSource(config(), fetchImpl).writeBack('th-9', 'failed');
    expect(result).toEqual({ written: false, code: 'skipped', reason: "no 'failed' writeback configured" });
    expect(calls).toHaveLength(0);
  });

  it('writeBack failed → note only (NEVER marks done) when configured', async () => {
    const { fetchImpl, calls } = makeGqlFetch((op) => {
      if (op === 'customer') return { data: { thread: { id: 'th-9', customer: { id: 'cust-9' } } } };
      if (op === 'note') return { data: { createNote: { error: null } } };
      return { data: {} };
    });
    const src = new PlainSource(config({ statusWriteback: { failed: 'could not finish' } }), fetchImpl);
    const result = await src.writeBack('th-9', 'failed');
    expect(result).toEqual({ written: true, code: 'written', value: 'noted (left open)' });
    const ops = calls.map((c) => opName(c.query));
    expect(ops).toContain('note');
    expect(ops).not.toContain('done'); // never marks done on failure
  });

  it('writeBack → not-found on a malformed (empty) id with no network calls', async () => {
    const { fetchImpl, calls } = makeGqlFetch(() => ({ data: {} }));
    const result = await new PlainSource(config(), fetchImpl).writeBack('   ', 'completed');
    expect(result.code).toBe('not-found');
    expect(calls).toHaveLength(0);
  });

  it('NEVER sends replyToThread — writeback is internal-only (createNote + markThreadAsDone)', async () => {
    const { fetchImpl, calls } = makeGqlFetch((op) => {
      if (op === 'customer') return { data: { thread: { id: 'th-9', customer: { id: 'cust-9' } } } };
      if (op === 'note') return { data: { createNote: { error: null } } };
      if (op === 'done') return { data: { markThreadAsDone: { error: null } } };
      return { data: {} };
    });
    const src = new PlainSource(config({ statusWriteback: { completed: 'done', failed: 'nope' } }), fetchImpl);
    await src.writeBack('th-9', 'completed');
    await src.writeBack('th-9', 'failed');
    expect(calls.some((c) => /replyToThread/i.test(c.query))).toBe(false);
  });

  it('checkConnection reports the workspace name', async () => {
    const { fetchImpl } = makeGqlFetch((op) =>
      op === 'workspace' ? { data: { myWorkspace: { id: 'ws1', name: 'Acme Support' } } } : { data: {} },
    );
    const result = await new PlainSource(config(), fetchImpl).checkConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('Acme Support');
  });
});
