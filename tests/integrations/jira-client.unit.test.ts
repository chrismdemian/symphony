import { describe, expect, it } from 'vitest';
import {
  createJiraClient,
  flattenAdf,
  textToAdf,
  JiraApiError,
} from '../../src/integrations/jira-client.js';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

function makeFetch(
  handler: (call: Call, index: number) => Response,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    };
    const index = calls.length;
    calls.push(call);
    return handler(call, index);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

const CREDS = { siteUrl: 'https://acme.atlassian.net', email: 'me@acme.io', token: 'tok' };

function rawIssue(over: Record<string, unknown> = {}) {
  return {
    key: 'ENG-1',
    fields: {
      summary: 'A bug',
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] },
      updated: '2026-06-01T00:00:00Z',
      project: { key: 'ENG' },
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      assignee: { displayName: 'Dana' },
      priority: { name: 'High' },
      labels: ['backend'],
      ...over,
    },
  };
}

describe('flattenAdf', () => {
  it('flattens a paragraph to its text', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] };
    expect(flattenAdf(doc)).toBe('hi');
  });

  it('joins block-level nodes with newlines, inline with empty string', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'line1' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'line2' }] },
      ],
    };
    expect(flattenAdf(doc)).toBe('line1\nline2');
  });

  it('joins bulletList items with newlines', () => {
    const doc = {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] },
      ],
    };
    expect(flattenAdf(doc)).toBe('a\nb');
  });

  it('drops non-text leaf nodes (mention/hardBreak) to empty string', () => {
    const doc = {
      type: 'paragraph',
      content: [{ type: 'text', text: 'hi ' }, { type: 'mention', attrs: { text: '@x' } }],
    };
    expect(flattenAdf(doc)).toBe('hi ');
  });

  it('handles null / string / plain text leaf', () => {
    expect(flattenAdf(null)).toBe('');
    expect(flattenAdf(undefined)).toBe('');
    expect(flattenAdf('raw')).toBe('raw');
    expect(flattenAdf({ type: 'text', text: 'leaf' })).toBe('leaf');
  });
});

describe('textToAdf', () => {
  it('wraps text in a minimal ADF doc', () => {
    expect(textToAdf('hi')).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
    });
  });
});

describe('createJiraClient.searchByJql', () => {
  it('POSTs to /search/jql with Basic auth + flattens ADF description', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ issues: [rawIssue()], isLast: true }));
    const client = createJiraClient(CREDS, { fetchImpl });
    const issues = await client.searchByJql('project = ENG', 50);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://acme.atlassian.net/rest/api/3/search/jql');
    // Basic base64("me@acme.io:tok")
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from('me@acme.io:tok').toString('base64')}`);
    const body = JSON.parse(call.body!);
    expect(body.jql).toBe('project = ENG');
    expect(body.fields).toContain('status');
    expect(body.fields).toContain('priority');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      key: 'ENG-1',
      summary: 'A bug',
      description: 'hello',
      statusName: 'To Do',
      statusCategoryKey: 'new',
      priorityName: 'High',
      projectKey: 'ENG',
      assignee: 'Dana',
      labels: ['backend'],
      webUrl: 'https://acme.atlassian.net/browse/ENG-1',
    });
  });

  it('paginates via nextPageToken until isLast', async () => {
    const { fetchImpl, calls } = makeFetch((_call, index) => {
      if (index === 0) {
        return jsonResponse({
          issues: [rawIssue({ summary: 'one' })],
          nextPageToken: 'tok2',
          isLast: false,
        });
      }
      const body = JSON.parse(calls[index]!.body!);
      expect(body.nextPageToken).toBe('tok2');
      return jsonResponse({ issues: [{ key: 'ENG-2', fields: { summary: 'two' } }], isLast: true });
    });
    const client = createJiraClient(CREDS, { fetchImpl });
    const issues = await client.searchByJql('x', 50);
    expect(issues.map((i) => i.key)).toEqual(['ENG-1', 'ENG-2']);
    expect(calls).toHaveLength(2);
  });

  it('stops on a zero-issue page even if isLast is not set (token-bug defense)', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ issues: [], nextPageToken: 'loops' }));
    const client = createJiraClient(CREDS, { fetchImpl });
    const issues = await client.searchByJql('x', 50);
    expect(issues).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('stops once the limit is reached', async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({
        issues: [rawIssue(), { key: 'ENG-2', fields: {} }],
        nextPageToken: 'more',
        isLast: false,
      }),
    );
    const client = createJiraClient(CREDS, { fetchImpl });
    const issues = await client.searchByJql('x', 2);
    expect(issues).toHaveLength(2);
  });
});

describe('createJiraClient transitions + comment', () => {
  it('GETs transitions and maps to status category', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse({
        transitions: [
          { id: '11', name: 'Start', to: { statusCategory: { key: 'indeterminate' } } },
          { id: '31', name: 'Done', to: { statusCategory: { key: 'done' } } },
        ],
      }),
    );
    const client = createJiraClient(CREDS, { fetchImpl });
    const ts = await client.getTransitions('ENG-1');
    expect(calls[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/issue/ENG-1/transitions');
    expect(ts).toEqual([
      { id: '11', name: 'Start', toStatusCategoryKey: 'indeterminate' },
      { id: '31', name: 'Done', toStatusCategoryKey: 'done' },
    ]);
  });

  it('POSTs a transition by id', async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const client = createJiraClient(CREDS, { fetchImpl });
    await client.transitionIssue('ENG-1', '31');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/issue/ENG-1/transitions');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ transition: { id: '31' } });
  });

  it('POSTs a comment as an ADF document', async () => {
    const { fetchImpl, calls } = makeFetch(() => new Response(null, { status: 201 }));
    const client = createJiraClient(CREDS, { fetchImpl });
    await client.addComment('ENG-1', 'Done by Symphony');
    expect(calls[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/issue/ENG-1/comment');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ body: textToAdf('Done by Symphony') });
  });
});

describe('createJiraClient getIssue / getRecentIssueKeys / getMyself', () => {
  it('getIssue requests the field set and maps', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse(rawIssue()));
    const client = createJiraClient(CREDS, { fetchImpl });
    const issue = await client.getIssue('ENG-1');
    expect(calls[0]!.url).toContain('/rest/api/3/issue/ENG-1?fields=');
    expect(issue!.key).toBe('ENG-1');
  });

  it('getIssue returns null on 404', async () => {
    const { fetchImpl } = makeFetch(() => new Response('gone', { status: 404 }));
    const client = createJiraClient(CREDS, { fetchImpl });
    expect(await client.getIssue('ENG-9')).toBeNull();
  });

  it('getRecentIssueKeys flattens the picker sections, deduped, capped', async () => {
    const { fetchImpl, calls } = makeFetch(() =>
      jsonResponse({
        sections: [
          { issues: [{ key: 'ENG-1' }, { key: 'ENG-2' }] },
          { issues: [{ key: 'ENG-2' }, { key: 'ENG-3' }] },
        ],
      }),
    );
    const client = createJiraClient(CREDS, { fetchImpl });
    const keys = await client.getRecentIssueKeys(2);
    expect(calls[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/issue/picker');
    expect(keys).toEqual(['ENG-1', 'ENG-2']);
  });

  it('getMyself returns the display name', async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ displayName: 'Chris' }));
    const client = createJiraClient(CREDS, { fetchImpl });
    expect(await client.getMyself()).toEqual({ displayName: 'Chris' });
  });
});

describe('createJiraClient error mapping', () => {
  it('maps 401 → auth failed', async () => {
    const { fetchImpl } = makeFetch(() => new Response('bad', { status: 401 }));
    const client = createJiraClient(CREDS, { fetchImpl });
    await expect(client.getMyself()).rejects.toMatchObject({ status: 401 });
  });

  it('maps 403 → forbidden (caller falls through the JQL chain)', async () => {
    const { fetchImpl } = makeFetch(() => new Response('no', { status: 403 }));
    const client = createJiraClient(CREDS, { fetchImpl });
    await expect(client.searchByJql('x', 10)).rejects.toMatchObject({ status: 403 });
  });

  it('wraps a network throw in JiraApiError', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const client = createJiraClient(CREDS, { fetchImpl });
    await expect(client.getMyself()).rejects.toBeInstanceOf(JiraApiError);
  });

  it('normalizes a trailing slash in siteUrl', async () => {
    const { fetchImpl, calls } = makeFetch(() => jsonResponse({ displayName: 'x' }));
    const client = createJiraClient({ ...CREDS, siteUrl: 'https://acme.atlassian.net/' }, { fetchImpl });
    await client.getMyself();
    expect(calls[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/myself');
  });
});
