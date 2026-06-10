/**
 * Phase 9B — unit coverage for the REAL notion-source plugin port
 * (`packages/examples/notion-source/src/notion.ts`). Drives the actual
 * `NotionSource` with an INJECTED fetch (no network) so the data-source
 * resolution, query pagination, page→issue mapping, and the status-vs-select
 * writeback branch are exercised faithfully.
 */
import { describe, expect, it } from 'vitest';

import {
  NotionSource,
  NotionSourceConfigSchema,
  mapPageToIssue,
  mapNotionStatus,
  mapNotionPriority,
  type NotionSourceConfig,
} from '../../packages/examples/notion-source/src/notion.js';

function config(overrides: Partial<Record<string, unknown>> = {}): NotionSourceConfig {
  return NotionSourceConfigSchema.parse({ token: 'secret_x', databaseId: 'db1', ...overrides });
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

type Call = { url: string; init?: RequestInit };

/** A fetch fake that routes by URL + method and records every call. */
function makeFetch(handlers: {
  db?: unknown;
  dataSource?: unknown;
  query?: unknown;
  user?: unknown;
  pageStatus?: number; // PATCH status (default 200)
}): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u.includes('/v1/databases/')) return jsonResponse(handlers.db ?? { data_sources: [{ id: 'ds1' }] });
    if (u.includes('/v1/data_sources/') && u.endsWith('/query') && method === 'POST') {
      return jsonResponse(handlers.query ?? { results: [], has_more: false });
    }
    if (u.includes('/v1/data_sources/') && method === 'GET') {
      return jsonResponse(handlers.dataSource ?? { properties: { Status: { type: 'status' } } });
    }
    if (u.includes('/v1/pages/') && method === 'PATCH') {
      const status = handlers.pageStatus ?? 200;
      return jsonResponse({}, { ok: status >= 200 && status < 300, status });
    }
    if (u.includes('/v1/users/me')) return jsonResponse(handlers.user ?? { name: 'Bot' });
    return jsonResponse({}, { ok: false, status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const PAGE_OPEN = {
  object: 'page',
  id: 'page-1',
  url: 'https://notion.so/page-1',
  last_edited_time: '2026-06-01T00:00:00Z',
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Ship it' }] },
    Status: { type: 'status', status: { name: 'In progress' } },
    Priority: { type: 'select', select: { name: 'High' } },
    Project: { type: 'select', select: { name: 'acme/widgets' } },
  },
};
const PAGE_DONE = {
  object: 'page',
  id: 'page-2',
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Old work' }] },
    Status: { type: 'status', status: { name: 'Done' } },
  },
};

describe('9B notion-source — pure mapping', () => {
  it('maps a page to a NormalizedIssue', () => {
    const issue = mapPageToIssue(config(), PAGE_OPEN);
    expect(issue).toMatchObject({
      externalId: 'page-1',
      title: 'Ship it',
      url: 'https://notion.so/page-1',
      state: 'In progress',
      isTerminal: false,
      projectValue: 'acme/widgets',
      priority: 2,
      updatedAt: '2026-06-01T00:00:00Z',
    });
  });

  it('flags a Done page as terminal (skipped by the ingest)', () => {
    expect(mapPageToIssue(config(), PAGE_DONE).isTerminal).toBe(true);
  });

  it('untitled page falls back to a placeholder; unmapped status → pending/non-terminal', () => {
    const issue = mapPageToIssue(config(), { id: 'p', properties: { Status: { type: 'status', status: { name: 'Weird' } } } });
    expect(issue.title).toBe('(untitled Notion page)');
    expect(issue.isTerminal).toBe(false);
    expect(issue.priority).toBe(0);
  });

  it('status + priority maps are case-insensitive', () => {
    expect(mapNotionStatus(config(), 'IN PROGRESS')).toBe('in_progress');
    expect(mapNotionStatus(config(), 'done')).toBe('completed');
    expect(mapNotionPriority(config(), 'HIGH')).toBe(2);
    expect(mapNotionStatus(config(), 'nonsense')).toBeUndefined();
  });
});

describe('9B notion-source — NotionSource I/O (injected fetch)', () => {
  it('resolves the data source then queries + maps pages', async () => {
    const { fetchImpl, calls } = makeFetch({
      query: { results: [PAGE_OPEN, PAGE_DONE], has_more: false },
    });
    const src = new NotionSource(config(), fetchImpl);
    const issues = await src.fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['page-1', 'page-2']);
    expect(issues[1]!.isTerminal).toBe(true);
    // databases.retrieve → data_sources.retrieve → query
    expect(calls[0]!.url).toContain('/v1/databases/db1');
    expect(calls[1]!.url).toContain('/v1/data_sources/ds1');
    expect(calls[2]!.url).toContain('/v1/data_sources/ds1/query');
  });

  it('skips databases.retrieve when dataSourceId is pinned', async () => {
    const { fetchImpl, calls } = makeFetch({ query: { results: [], has_more: false } });
    const src = new NotionSource(config({ dataSourceId: 'pinned' }), fetchImpl);
    await src.fetchOpenIssues();
    expect(calls.some((c) => c.url.includes('/v1/databases/'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/v1/data_sources/pinned'))).toBe(true);
  });

  it('writeback completed → status-type body PATCH', async () => {
    const { fetchImpl, calls } = makeFetch({ dataSource: { properties: { Status: { type: 'status' } } } });
    const src = new NotionSource(config(), fetchImpl);
    const result = await src.writeBack('page-1', 'completed');
    expect(result).toEqual({ written: true, code: 'written', value: 'Done' });
    const patch = calls.find((c) => c.url.includes('/v1/pages/page-1') && c.init?.method === 'PATCH');
    expect(JSON.parse(String(patch!.init!.body))).toEqual({
      properties: { Status: { status: { name: 'Done' } } },
    });
  });

  it('writeback completed → select-type body PATCH when the property is a select', async () => {
    const { fetchImpl, calls } = makeFetch({ dataSource: { properties: { Status: { type: 'select' } } } });
    const src = new NotionSource(config(), fetchImpl);
    await src.writeBack('page-1', 'completed');
    const patch = calls.find((c) => c.init?.method === 'PATCH');
    expect(JSON.parse(String(patch!.init!.body))).toEqual({
      properties: { Status: { select: { name: 'Done' } } },
    });
  });

  it('writeback failed → skipped when no failed value configured', async () => {
    const { fetchImpl, calls } = makeFetch({});
    const src = new NotionSource(config(), fetchImpl);
    const result = await src.writeBack('page-1', 'failed');
    expect(result.code).toBe('skipped');
    expect(calls.some((c) => c.init?.method === 'PATCH')).toBe(false);
  });

  it('writeback 404 → not-found', async () => {
    const { fetchImpl } = makeFetch({ pageStatus: 404 });
    const src = new NotionSource(config(), fetchImpl);
    const result = await src.writeBack('missing', 'completed');
    expect(result.code).toBe('not-found');
  });

  it('checkConnection reports the bot name', async () => {
    const { fetchImpl } = makeFetch({ user: { name: 'My Integration' } });
    const result = await new NotionSource(config(), fetchImpl).checkConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('My Integration');
  });
});
