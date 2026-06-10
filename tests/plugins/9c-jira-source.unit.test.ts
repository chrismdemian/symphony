/**
 * Phase 9C.1 — unit coverage for the REAL jira-source plugin port
 * (`packages/examples/jira-source/src/jira.ts`). Drives the actual `JiraSource`
 * with an INJECTED fetch (no network) so the enhanced-JQL search, the JQL
 * fallback chain, ADF flattening, and the comment+transition writeback (incl.
 * the "commented but no Done transition" case) are exercised faithfully.
 */
import { describe, expect, it } from 'vitest';

import {
  JiraSource,
  JiraSourceConfigSchema,
  flattenAdf,
  textToAdf,
  jiraPriorityToSymphony,
  mapRawIssue,
  mapJiraIssue,
  type JiraSourceConfig,
} from '../../packages/examples/jira-source/src/jira.js';

const BASE = 'https://acme.atlassian.net';

function config(overrides: Partial<Record<string, unknown>> = {}): JiraSourceConfig {
  return JiraSourceConfigSchema.parse({
    token: 'jira_tok',
    siteUrl: BASE,
    email: 'you@acme.com',
    ...overrides,
  });
}

interface FakeResp {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): FakeResp {
  const status = init.status ?? 200;
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };

interface JiraHandlers {
  search?: (jql: string) => unknown; // body for POST /search/jql
  picker?: unknown; // body for GET /issue/picker
  getIssue?: (key: string) => unknown | FakeResp;
  transitions?: (key: string) => unknown; // body for GET /transitions
  commentStatus?: number;
  transitionStatus?: number;
  myself?: unknown;
}

function jiraFetch(h: JiraHandlers): { fetchImpl: typeof fetch; calls: Call[]; auth: () => string | undefined } {
  const calls: Call[] = [];
  let lastAuth: string | undefined;
  const keyOf = (u: string): string => decodeURIComponent(/\/issue\/([^/?]+)/.exec(u)?.[1] ?? '');
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    lastAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
    calls.push({ url: u, method, body });
    if (u.includes('/search/jql') && method === 'POST') {
      return jsonResponse(h.search ? h.search(String(body?.jql ?? '')) : { issues: [], isLast: true }) as unknown as Response;
    }
    if (u.includes('/issue/picker')) return jsonResponse(h.picker ?? { sections: [] }) as unknown as Response;
    if (/\/issue\/[^/]+\/transitions$/.test(u) && method === 'GET') {
      return jsonResponse(h.transitions ? h.transitions(keyOf(u)) : { transitions: [] }) as unknown as Response;
    }
    if (/\/issue\/[^/]+\/transitions$/.test(u) && method === 'POST') {
      const s = h.transitionStatus ?? 200;
      return jsonResponse({}, { status: s }) as unknown as Response;
    }
    if (/\/issue\/[^/]+\/comment$/.test(u) && method === 'POST') {
      const s = h.commentStatus ?? 200;
      return jsonResponse({}, { status: s }) as unknown as Response;
    }
    if (/\/issue\/[^/?]+(\?|$)/.test(u) && method === 'GET') {
      const out = h.getIssue ? h.getIssue(keyOf(u)) : null;
      if (out !== null && typeof out === 'object' && 'json' in (out as object)) return out as unknown as Response;
      return jsonResponse(out) as unknown as Response;
    }
    if (u.includes('/myself')) return jsonResponse(h.myself ?? { displayName: 'Ada' }) as unknown as Response;
    return jsonResponse({}, { status: 404 }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, auth: () => lastAuth };
}

type RawJiraIssue = Parameters<typeof mapRawIssue>[0];

function rawIssue(key: string, statusCat: string, fieldOverrides: Record<string, unknown> = {}): RawJiraIssue {
  return {
    key,
    fields: {
      summary: `Issue ${key}`,
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'body' }] }] },
      updated: '2026-06-01T00:00:00Z',
      project: { key: 'ENG' },
      status: { name: statusCat === 'done' ? 'Done' : 'In Progress', statusCategory: { key: statusCat } },
      assignee: { displayName: 'Ada' },
      priority: { name: 'High' },
      labels: ['backend'],
      ...fieldOverrides,
    },
  } as RawJiraIssue;
}

describe('9C.1 jira-source — pure mapping', () => {
  it('flattenAdf joins block containers with newlines, inline with empty string', () => {
    expect(
      flattenAdf({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'line 2' }] },
        ],
      }),
    ).toBe('Hello world\nline 2');
    expect(flattenAdf('already a string')).toBe('already a string');
    expect(flattenAdf(null)).toBe('');
    expect(flattenAdf({ type: 'mention' })).toBe(''); // unknown leaf
  });

  it('textToAdf wraps text in a minimal ADF document', () => {
    expect(textToAdf('hi')).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
    });
  });

  it('jiraPriorityToSymphony maps the standard scheme', () => {
    expect(jiraPriorityToSymphony('Highest')).toBe(3);
    expect(jiraPriorityToSymphony('Blocker')).toBe(3);
    expect(jiraPriorityToSymphony('High')).toBe(2);
    expect(jiraPriorityToSymphony('Medium')).toBe(1);
    expect(jiraPriorityToSymphony('Low')).toBe(0);
    expect(jiraPriorityToSymphony(null)).toBe(0);
  });

  it('mapRawIssue lifts nested fields + builds the browse url; mapJiraIssue normalizes', () => {
    const node = mapRawIssue(rawIssue('ENG-1', 'indeterminate'), BASE);
    expect(node).toMatchObject({
      key: 'ENG-1',
      summary: 'Issue ENG-1',
      description: 'body',
      webUrl: 'https://acme.atlassian.net/browse/ENG-1',
      statusCategoryKey: 'indeterminate',
      priorityName: 'High',
      labels: ['backend'],
      assignee: 'Ada',
      projectKey: 'ENG',
    });
    const issue = mapJiraIssue(node);
    expect(issue).toMatchObject({
      externalId: 'ENG-1',
      title: 'Issue ENG-1',
      url: 'https://acme.atlassian.net/browse/ENG-1',
      isTerminal: false,
      projectValue: 'ENG',
      priority: 2,
    });
  });

  it('mapJiraIssue flags a done-category issue terminal; empty labels filtered', () => {
    const node = mapRawIssue(rawIssue('ENG-2', 'done', { labels: ['x', ''] }), BASE);
    expect(node.labels).toEqual(['x']);
    expect(mapJiraIssue(node).isTerminal).toBe(true);
  });
});

describe('9C.1 jira-source — JiraSource I/O (injected fetch)', () => {
  it('fetchOpenIssues uses the project candidate first, Basic auth, bounded JQL', async () => {
    const { fetchImpl, calls, auth } = jiraFetch({
      search: (jql) => (jql.includes('project IN (ENG)') ? { issues: [rawIssue('ENG-1', 'indeterminate')], isLast: true } : { issues: [], isLast: true }),
    });
    const src = new JiraSource(config({ projectKeys: ['ENG'] }), fetchImpl);
    const issues = await src.fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['ENG-1']);
    expect(auth()).toMatch(/^Basic /);
    const search = calls.find((c) => c.url.includes('/search/jql'))!;
    expect(String(search.body!.jql)).toContain('statusCategory != Done');
  });

  it('falls through the JQL chain to the catch-all when assignee/reporter are empty', async () => {
    const seen: string[] = [];
    const { fetchImpl } = jiraFetch({
      search: (jql) => {
        seen.push(jql);
        if (jql.includes('assignee') || jql.includes('reporter')) return { issues: [], isLast: true };
        return { issues: [rawIssue('ENG-7', 'new')], isLast: true }; // the bare catch-all
      },
    });
    const issues = await new JiraSource(config(), fetchImpl).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['ENG-7']);
    expect(seen.some((j) => j.includes('assignee'))).toBe(true);
    expect(seen.some((j) => j.includes('reporter'))).toBe(true);
  });

  it('falls back to the issue-picker history when every JQL candidate is empty', async () => {
    const { fetchImpl, calls } = jiraFetch({
      search: () => ({ issues: [], isLast: true }),
      picker: { sections: [{ issues: [{ key: 'ENG-9' }] }] },
      getIssue: (key) => rawIssue(key, 'indeterminate'),
    });
    const issues = await new JiraSource(config(), fetchImpl).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['ENG-9']);
    expect(calls.some((c) => c.url.includes('/issue/picker'))).toBe(true);
  });

  it('searchIssues runs a text ~ JQL query', async () => {
    const { fetchImpl, calls } = jiraFetch({ search: () => ({ issues: [rawIssue('ENG-1', 'new')], isLast: true }) });
    await new JiraSource(config(), fetchImpl).searchIssues('login "bug"');
    const search = calls.find((c) => c.url.includes('/search/jql'))!;
    expect(String(search.body!.jql)).toContain('text ~ "login \\"bug\\""');
  });

  it('writeBack completed → comment (ADF) then transition to the first Done-category state', async () => {
    const { fetchImpl, calls } = jiraFetch({
      transitions: () => ({
        transitions: [
          { id: 't1', name: 'Start', to: { statusCategory: { key: 'indeterminate' } } },
          { id: 't2', name: 'Done', to: { statusCategory: { key: 'done' } } },
        ],
      }),
    });
    const result = await new JiraSource(config(), fetchImpl).writeBack('ENG-1', 'completed');
    expect(result).toEqual({ written: true, code: 'written', value: "commented + transitioned to 'Done'" });
    const comment = calls.find((c) => c.url.endsWith('/comment') && c.method === 'POST')!;
    expect((comment.body!.body as { type: string }).type).toBe('doc'); // ADF, not a string
    const transition = calls.find((c) => c.url.endsWith('/transitions') && c.method === 'POST')!;
    expect((transition.body!.transition as { id: string }).id).toBe('t2');
  });

  it('writeBack completed honors a completedTransition name override', async () => {
    const { fetchImpl, calls } = jiraFetch({
      transitions: () => ({
        transitions: [
          { id: 't1', name: 'Ship It', to: { statusCategory: { key: 'indeterminate' } } },
          { id: 't2', name: 'Done', to: { statusCategory: { key: 'done' } } },
        ],
      }),
    });
    const src = new JiraSource(config({ statusWriteback: { completedTransition: 'ship it' } }), fetchImpl);
    const result = await src.writeBack('ENG-1', 'completed');
    expect(result.value).toBe("commented + transitioned to 'Ship It'");
    expect((calls.find((c) => c.url.endsWith('/transitions') && c.method === 'POST')!.body!.transition as { id: string }).id).toBe('t1');
  });

  it('writeBack completed but no Done transition → not-found (comment still posted)', async () => {
    const { fetchImpl, calls } = jiraFetch({
      transitions: () => ({ transitions: [{ id: 't1', name: 'Start', to: { statusCategory: { key: 'indeterminate' } } }] }),
    });
    const result = await new JiraSource(config(), fetchImpl).writeBack('ENG-1', 'completed');
    expect(result.written).toBe(false);
    expect(result.code).toBe('not-found');
    expect(result.reason).toContain('no Done transition');
    // The comment DID post even though the transition couldn't resolve.
    expect(calls.some((c) => c.url.endsWith('/comment') && c.method === 'POST')).toBe(true);
    // No transition POST was attempted.
    expect(calls.some((c) => c.url.endsWith('/transitions') && c.method === 'POST')).toBe(false);
  });

  it('writeBack failed → skipped (no API call) when not configured', async () => {
    const { fetchImpl, calls } = jiraFetch({});
    const result = await new JiraSource(config(), fetchImpl).writeBack('ENG-1', 'failed');
    expect(result).toEqual({ written: false, code: 'skipped', reason: "no 'failed' writeback configured" });
    expect(calls).toHaveLength(0);
  });

  it('writeBack failed → comment only, never transitions, when configured', async () => {
    const { fetchImpl, calls } = jiraFetch({});
    const src = new JiraSource(config({ statusWriteback: { failed: 'Failed by Symphony.' } }), fetchImpl);
    const result = await src.writeBack('ENG-1', 'failed');
    expect(result).toEqual({ written: true, code: 'written', value: 'commented (no transition)' });
    expect(calls.some((c) => c.url.endsWith('/comment') && c.method === 'POST')).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/transitions'))).toBe(false);
  });

  it('writeBack → not-found on a 404 from the comment endpoint', async () => {
    const { fetchImpl } = jiraFetch({ commentStatus: 404 });
    const result = await new JiraSource(config(), fetchImpl).writeBack('ENG-404', 'completed');
    expect(result.code).toBe('not-found');
  });

  it('writeBack → not-found on an empty key', async () => {
    const { fetchImpl, calls } = jiraFetch({});
    const result = await new JiraSource(config(), fetchImpl).writeBack('   ', 'completed');
    expect(result.code).toBe('not-found');
    expect(calls).toHaveLength(0);
  });

  it('checkConnection reports the authenticated display name', async () => {
    const { fetchImpl } = jiraFetch({ myself: { displayName: 'Ada Lovelace' } });
    const result = await new JiraSource(config(), fetchImpl).checkConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('Ada Lovelace');
  });
});
