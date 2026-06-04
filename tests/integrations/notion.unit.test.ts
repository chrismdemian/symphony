import { describe, expect, it, vi } from 'vitest';
import {
  NotionConnector,
  NotionError,
  type NotionConnectorDeps,
} from '../../src/integrations/notion.js';
import { defaultNotionConfig, type NotionConfig } from '../../src/integrations/notion-config.js';
import type {
  NotionClientLike,
  NotionPage,
  NotionQueryArgs,
  NotionQueryResponse,
} from '../../src/integrations/notion-client.js';

interface FakeClientSpec {
  readonly dataSources?: readonly { id: string; name?: string }[];
  readonly statusPropType?: 'status' | 'select' | 'missing';
  /** Pages returned by query, optionally split into pages for pagination. */
  readonly pages?: NotionPage[];
  readonly pageSplits?: NotionPage[][];
}

interface FakeClient extends NotionClientLike {
  readonly calls: {
    databasesRetrieve: number;
    dataSourcesRetrieve: number;
    queries: NotionQueryArgs[];
    pageUpdates: { page_id: string; properties: Record<string, unknown> }[];
  };
}

function makeFakeClient(spec: FakeClientSpec = {}): FakeClient {
  const dataSources = spec.dataSources ?? [{ id: 'ds-1', name: 'Tasks' }];
  const statusPropType = spec.statusPropType ?? 'status';
  const properties: Record<string, { type?: string }> = {};
  if (statusPropType !== 'missing') properties['Status'] = { type: statusPropType };
  const splits = spec.pageSplits ?? (spec.pages ? [spec.pages] : [[]]);
  const calls = {
    databasesRetrieve: 0,
    dataSourcesRetrieve: 0,
    queries: [] as NotionQueryArgs[],
    pageUpdates: [] as { page_id: string; properties: Record<string, unknown> }[],
  };
  let queryIdx = 0;
  return {
    calls,
    databases: {
      retrieve: async () => {
        calls.databasesRetrieve += 1;
        return { id: 'db-1', data_sources: dataSources };
      },
    },
    dataSources: {
      retrieve: async () => {
        calls.dataSourcesRetrieve += 1;
        return { id: 'ds-1', properties };
      },
      query: async (args: NotionQueryArgs): Promise<NotionQueryResponse> => {
        calls.queries.push(args);
        const batch = splits[queryIdx] ?? [];
        const hasMore = queryIdx < splits.length - 1;
        queryIdx += 1;
        return {
          results: batch,
          has_more: hasMore,
          next_cursor: hasMore ? `cursor-${queryIdx}` : null,
        };
      },
    },
    pages: {
      update: async (args) => {
        calls.pageUpdates.push(args);
        return {};
      },
    },
  };
}

function page(id: string, props: Record<string, unknown>): NotionPage {
  return { object: 'page', id, url: `https://notion.so/${id}`, properties: props as never };
}

function connector(
  client: NotionClientLike,
  config: NotionConfig = defaultNotionConfig('db-1'),
  extra: Partial<NotionConnectorDeps> = {},
): NotionConnector {
  return new NotionConnector({ client, config, minGapMs: 0, ...extra });
}

describe('NotionConnector.resolveSchema', () => {
  it('resolves database → first data source and detects a status-type property', async () => {
    const client = makeFakeClient({ statusPropType: 'status' });
    const schema = await connector(client).resolveSchema();
    expect(schema.dataSourceId).toBe('ds-1');
    expect(schema.statusPropType).toBe('status');
    expect(client.calls.databasesRetrieve).toBe(1);
  });

  it('detects a select-type status property', async () => {
    const client = makeFakeClient({ statusPropType: 'select' });
    const schema = await connector(client).resolveSchema();
    expect(schema.statusPropType).toBe('select');
  });

  it('skips databases.retrieve when dataSourceId is pinned in config', async () => {
    const client = makeFakeClient();
    const cfg = { ...defaultNotionConfig('db-1'), dataSourceId: 'ds-pinned' };
    const schema = await connector(client, cfg).resolveSchema();
    expect(schema.dataSourceId).toBe('ds-pinned');
    expect(client.calls.databasesRetrieve).toBe(0);
  });

  it('memoizes — a second call makes no extra API calls', async () => {
    const client = makeFakeClient();
    const c = connector(client);
    await c.resolveSchema();
    await c.resolveSchema();
    expect(client.calls.databasesRetrieve).toBe(1);
    expect(client.calls.dataSourcesRetrieve).toBe(1);
  });

  it('throws NotionError when the database exposes no data sources', async () => {
    const client = makeFakeClient({ dataSources: [] });
    await expect(connector(client).resolveSchema()).rejects.toBeInstanceOf(NotionError);
  });
});

describe('NotionConnector.fetchOpenPages', () => {
  it('maps title, status, priority, and project value', async () => {
    const client = makeFakeClient({
      pages: [
        page('p1', {
          Name: { type: 'title', title: [{ plain_text: 'Fix the bug' }] },
          Status: { type: 'status', status: { name: 'In Progress' } },
          Project: { type: 'select', select: { name: 'symphony' } },
          Priority: { type: 'select', select: { name: 'High' } },
        }),
      ],
    });
    const [candidate] = await connector(client).fetchOpenPages();
    expect(candidate).toEqual({
      pageId: 'p1',
      url: 'https://notion.so/p1',
      title: 'Fix the bug',
      status: 'in_progress',
      priority: 2,
      projectValue: 'symphony',
    });
  });

  it('treats unmapped Notion status as pending and missing priority as 0', async () => {
    const client = makeFakeClient({
      pages: [
        page('p1', {
          Name: { type: 'title', title: [{ plain_text: 'X' }] },
          Status: { type: 'status', status: { name: 'Weird Stage' } },
        }),
      ],
    });
    const [candidate] = await connector(client).fetchOpenPages();
    expect(candidate?.status).toBe('pending');
    expect(candidate?.priority).toBe(0);
    expect(candidate?.projectValue).toBeNull();
  });

  it('falls back to a placeholder title for an untitled page', async () => {
    const client = makeFakeClient({
      pages: [page('p1', { Status: { type: 'status', status: { name: 'To Do' } } })],
    });
    const [candidate] = await connector(client).fetchOpenPages();
    expect(candidate?.title).toBe('(untitled Notion page)');
  });

  it('reads project from a multi_select first option', async () => {
    const client = makeFakeClient({
      pages: [
        page('p1', {
          Name: { type: 'title', title: [{ plain_text: 'T' }] },
          Project: { type: 'multi_select', multi_select: [{ name: 'alpha' }, { name: 'beta' }] },
        }),
      ],
    });
    const [candidate] = await connector(client).fetchOpenPages();
    expect(candidate?.projectValue).toBe('alpha');
  });

  it('paginates across cursors and respects the limit', async () => {
    const client = makeFakeClient({
      pageSplits: [
        [page('p1', { Name: { type: 'title', title: [{ plain_text: 'a' }] } })],
        [page('p2', { Name: { type: 'title', title: [{ plain_text: 'b' }] } })],
      ],
    });
    const out = await connector(client).fetchOpenPages({ limit: 5 });
    expect(out.map((c) => c.pageId)).toEqual(['p1', 'p2']);
    // Second query carried the next_cursor.
    expect(client.calls.queries[1]?.start_cursor).toBe('cursor-1');
  });

  it('stops at the requested limit without over-fetching', async () => {
    const client = makeFakeClient({
      pages: [
        page('p1', { Name: { type: 'title', title: [{ plain_text: 'a' }] } }),
        page('p2', { Name: { type: 'title', title: [{ plain_text: 'b' }] } }),
        page('p3', { Name: { type: 'title', title: [{ plain_text: 'c' }] } }),
      ],
    });
    const out = await connector(client).fetchOpenPages({ limit: 2 });
    expect(out).toHaveLength(2);
  });
});

describe('NotionConnector.writeBackStatus', () => {
  it('writes the configured "completed" value as a status property', async () => {
    const client = makeFakeClient({ statusPropType: 'status' });
    const result = await connector(client).writeBackStatus('p1', 'completed');
    expect(result).toEqual({ written: true, value: 'Done' });
    expect(client.calls.pageUpdates[0]).toEqual({
      page_id: 'p1',
      properties: { Status: { status: { name: 'Done' } } },
    });
  });

  it('uses the select shape when the status property is a select', async () => {
    const client = makeFakeClient({ statusPropType: 'select' });
    await connector(client).writeBackStatus('p1', 'completed');
    expect(client.calls.pageUpdates[0]?.properties).toEqual({
      Status: { select: { name: 'Done' } },
    });
  });

  it('does not write back failed when no failed value is configured', async () => {
    const client = makeFakeClient();
    const result = await connector(client).writeBackStatus('p1', 'failed');
    expect(result.written).toBe(false);
    expect(client.calls.pageUpdates).toHaveLength(0);
  });

  it('writes back failed when a failed value is configured', async () => {
    const client = makeFakeClient({ statusPropType: 'status' });
    const cfg: NotionConfig = {
      ...defaultNotionConfig('db-1'),
      statusWriteback: { completed: 'Done', failed: 'Blocked' },
    };
    const result = await connector(client, cfg).writeBackStatus('p1', 'failed');
    expect(result).toEqual({ written: true, value: 'Blocked' });
    expect(client.calls.pageUpdates[0]?.properties).toEqual({
      Status: { status: { name: 'Blocked' } },
    });
  });
});

describe('NotionConnector throttle', () => {
  it('enforces the minimum gap between successive requests', async () => {
    const client = makeFakeClient();
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const c = connector(client, defaultNotionConfig('db-1'), {
      minGapMs: 100,
      now: () => clock,
      sleep: vi.fn(async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      }),
    });
    // resolveSchema makes two back-to-back calls: the first runs
    // immediately (huge elapsed), the second must wait one gap.
    await c.resolveSchema();
    expect(sleeps).toEqual([100]);
  });
});
