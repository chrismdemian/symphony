/**
 * Phase 9C.3 — unit coverage for the REAL sentry-source plugin port
 * (`packages/examples/sentry-source/src/sentry.ts`). Drives the actual
 * `SentrySource` with an INJECTED fetch (no network) so the Bearer-token auth
 * (NOT a DSN), the `<project>#<numericGroupId>` externalId, the `results="true"`
 * Link cursor, the empty-`statsPeriod` list query, the level pseudo-label,
 * multi-project skip-on-fail, and the note-default + opt-in-resolve writeback are
 * exercised faithfully.
 *
 * The load-bearing footgun: `failed` NEVER resolves — even with
 * `resolveOnCompleted: true`. The dedicated test locks it.
 */
import { describe, expect, it } from 'vitest';

import {
  SentrySource,
  SentrySourceConfigSchema,
  mapSentryIssue,
  sentryLevelToPriority,
  parseSentryExternalId,
  type SentrySourceConfig,
  type SentryIssueNode,
} from '../../packages/examples/sentry-source/src/sentry.js';

function config(overrides: Partial<Record<string, unknown>> = {}): SentrySourceConfig {
  return SentrySourceConfigSchema.parse({ token: 'sntry_x', org: 'acme', projects: ['backend'], ...overrides });
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}
interface RespSpec {
  status?: number;
  json?: unknown;
  headers?: Record<string, string>;
}

/** A REST fetch fake: `handler(req)` returns a response spec; calls are captured. */
function makeFetch(
  handler: (req: { url: string; method: string; body: string | undefined; headers: Record<string, string> }) => RespSpec,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : String(init.body);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, method, headers, body });
    const r = handler({ url: u, method, body, headers }) ?? {};
    const status = r.status ?? 200;
    const respHeaders = r.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'OK',
      json: async () => r.json ?? {},
      text: async () => JSON.stringify(r.json ?? {}),
      headers: { get: (k: string) => respHeaders[k.toLowerCase()] ?? null },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function rawIssue(id: number, status = 'unresolved', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    shortId: `BACKEND-${id}`,
    title: `Error ${id}`,
    culprit: `app/routes/${id}.ts`,
    permalink: `https://sentry.io/acme/backend/issues/${id}/`,
    status,
    level: 'error',
    lastSeen: '2026-06-01T00:00:00Z',
    assignedTo: { name: 'Ada' },
    ...extra,
  };
}

const NODE: SentryIssueNode = {
  project: 'backend',
  id: '42',
  shortId: 'BACKEND-42',
  title: 'TypeError: undefined is not a function',
  culprit: 'app/routes/checkout.ts',
  permalink: 'https://sentry.io/acme/backend/issues/42/',
  status: 'unresolved',
  level: 'fatal',
  lastSeen: '2026-06-01T00:00:00Z',
  assignee: 'Ada',
};

describe('9C.3 sentry-source — pure mapping', () => {
  it('maps an issue (<project>#<id> externalId, level pseudo-label, project route, fatal priority)', () => {
    expect(mapSentryIssue(NODE)).toEqual({
      externalId: 'backend#42',
      title: 'TypeError: undefined is not a function',
      url: 'https://sentry.io/acme/backend/issues/42/',
      state: 'unresolved',
      isTerminal: false,
      body: 'app/routes/checkout.ts',
      assignee: 'Ada',
      labels: ['fatal'], // the level rides as a single pseudo-label
      projectValue: 'backend',
      priority: 3, // fatal
      updatedAt: '2026-06-01T00:00:00Z',
    });
  });

  it('flags resolved/ignored/muted terminal; unresolved is the only actionable state', () => {
    expect(mapSentryIssue({ ...NODE, status: 'resolved' }).isTerminal).toBe(true);
    expect(mapSentryIssue({ ...NODE, status: 'ignored' }).isTerminal).toBe(true);
    expect(mapSentryIssue({ ...NODE, status: 'muted' }).isTerminal).toBe(true);
    expect(mapSentryIssue({ ...NODE, status: 'unresolved' }).isTerminal).toBe(false);
  });

  it('empty level → no label; untitled issue falls back to the shortId', () => {
    expect(mapSentryIssue({ ...NODE, level: null }).labels).toEqual([]);
    expect(mapSentryIssue({ ...NODE, title: '  ' }).title).toBe('(untitled Sentry issue BACKEND-42)');
  });

  it('sentryLevelToPriority: fatal 3 / error 2 / warning 1 / else 0', () => {
    expect(sentryLevelToPriority('fatal')).toBe(3);
    expect(sentryLevelToPriority('error')).toBe(2);
    expect(sentryLevelToPriority('warning')).toBe(1);
    expect(sentryLevelToPriority('info')).toBe(0);
    expect(sentryLevelToPriority(null)).toBe(0);
  });

  it('parseSentryExternalId: splits on last #, strict decimal id', () => {
    expect(parseSentryExternalId('backend#42')).toEqual({ project: 'backend', id: '42' });
    expect(parseSentryExternalId('no-hash')).toBeUndefined();
    expect(parseSentryExternalId('backend#')).toBeUndefined();
    expect(parseSentryExternalId('#42')).toBeUndefined();
    expect(parseSentryExternalId('backend#4a')).toBeUndefined(); // non-decimal
  });
});

describe('9C.3 sentry-source — config schema (activation guard)', () => {
  it('requires token + org + at least one project', () => {
    expect(SentrySourceConfigSchema.safeParse({ token: 'x' }).success).toBe(false); // no org/projects
    expect(SentrySourceConfigSchema.safeParse({ token: 'x', org: 'acme', projects: [] }).success).toBe(false);
    expect(SentrySourceConfigSchema.safeParse({ token: 'x', org: 'acme', projects: ['p'] }).success).toBe(true);
  });

  it('rejects org/project slugs that could inject into the URL path', () => {
    expect(SentrySourceConfigSchema.safeParse({ token: 'x', org: 'a/b', projects: ['p'] }).success).toBe(false);
    expect(SentrySourceConfigSchema.safeParse({ token: 'x', org: 'acme', projects: ['p/../q'] }).success).toBe(false);
  });
});

describe('9C.3 sentry-source — SentrySource I/O (injected fetch)', () => {
  it('fetchOpenIssues sends Bearer auth, sort=new + empty statsPeriod, maps to <project>#<id>', async () => {
    const { fetchImpl, calls } = makeFetch((req) =>
      req.url.includes('/issues/?') ? { json: [rawIssue(1), rawIssue(2, 'resolved')] } : {},
    );
    const issues = await new SentrySource(config(), fetchImpl).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['backend#1', 'backend#2']);
    expect(issues[1]!.isTerminal).toBe(true);
    expect(calls[0]!.headers.authorization).toBe('Bearer sntry_x'); // Bearer token, NOT a DSN
    expect(calls[0]!.url).toContain('query=is%3Aunresolved');
    expect(calls[0]!.url).toContain('sort=new');
    expect(calls[0]!.url).toContain('statsPeriod=&'); // empty — disables the 24h window
    expect(calls[0]!.url).toContain('/projects/acme/backend/issues/');
  });

  it('missing status maps to unresolved (fail-safe: never silently terminal)', async () => {
    const { fetchImpl } = makeFetch((req) =>
      req.url.includes('/issues/?') ? { json: [{ id: 7, title: 'no status', level: 'error' }] } : {},
    );
    const issues = await new SentrySource(config(), fetchImpl).fetchOpenIssues();
    expect(issues[0]!.state).toBe('unresolved');
    expect(issues[0]!.isTerminal).toBe(false);
  });

  it('aggregates across projects; skips a 404 project but throws only if EVERY project fails', async () => {
    const { fetchImpl } = makeFetch((req) => {
      if (req.url.includes('/backend/')) return { status: 404, json: { detail: 'gone' } };
      if (req.url.includes('/frontend/')) return { json: [rawIssue(5)] };
      return {};
    });
    const partial = new SentrySource(config({ projects: ['backend', 'frontend'] }), fetchImpl);
    expect((await partial.fetchOpenIssues()).map((i) => i.externalId)).toEqual(['frontend#5']);

    const { fetchImpl: allFail } = makeFetch(() => ({ status: 403, json: { detail: 'no' } }));
    await expect(new SentrySource(config(), allFail).fetchOpenIssues()).rejects.toThrow(/403/);
  });

  it('Link cursor: follows rel="next" only while results="true", stops on results="false"', async () => {
    const page2 = 'https://sentry.io/api/0/projects/acme/backend/issues/?cursor=p2';
    const { fetchImpl, calls } = makeFetch((req) => {
      if (req.url === page2) {
        return { json: [rawIssue(3)], headers: { link: `<${page2}>; rel="next"; results="false"` } };
      }
      if (req.url.includes('/issues/?')) {
        return { json: [rawIssue(1), rawIssue(2)], headers: { link: `<${page2}>; rel="next"; results="true"` } };
      }
      return {};
    });
    const issues = await new SentrySource(config(), fetchImpl).fetchOpenIssues(3);
    expect(issues.map((i) => i.externalId)).toEqual(['backend#1', 'backend#2', 'backend#3']);
    expect(calls.some((c) => c.url === page2)).toBe(true);
  });

  it('Link cursor: a results="false" first page stops immediately (Sentry always emits next)', async () => {
    let listCalls = 0;
    const { fetchImpl } = makeFetch((req) => {
      if (req.url.includes('/issues/?')) {
        listCalls += 1;
        return { json: [rawIssue(1)], headers: { link: '<https://x/next>; rel="next"; results="false"' } };
      }
      return {};
    });
    await new SentrySource(config(), fetchImpl).fetchOpenIssues(50);
    expect(listCalls).toBe(1); // never followed the always-present next link
  });

  it('searchIssues sends query=is:unresolved <term>', async () => {
    const { fetchImpl, calls } = makeFetch((req) => (req.url.includes('/issues/?') ? { json: [rawIssue(1)] } : {}));
    const issues = await new SentrySource(config(), fetchImpl).searchIssues('checkout');
    expect(issues).toHaveLength(1);
    expect(calls[0]!.url).toContain(encodeURIComponent('is:unresolved checkout'));
  });

  it('writeBack completed (default) → note only, left unresolved (POST /issues/{id}/notes/)', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({}));
    const result = await new SentrySource(config(), fetchImpl).writeBack('backend#42', 'completed');
    expect(result).toEqual({ written: true, code: 'written', value: 'noted (left unresolved)' });
    const note = calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/42/notes/'))!;
    expect(JSON.parse(note.body!).text).toBe('Investigated by Symphony.');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false); // never resolved
  });

  it('writeBack completed with resolveOnCompleted → note + resolve (org-scoped PUT)', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({}));
    const src = new SentrySource(config({ resolveOnCompleted: true }), fetchImpl);
    const result = await src.writeBack('backend#42', 'completed');
    expect(result).toEqual({ written: true, code: 'written', value: 'noted + resolved' });
    const resolve = calls.find((c) => c.method === 'PUT')!;
    expect(resolve.url).toBe('https://sentry.io/api/0/organizations/acme/issues/42/');
    expect(JSON.parse(resolve.body!).status).toBe('resolved');
  });

  it('writeBack failed → note only, NEVER resolves — even with resolveOnCompleted: true', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({}));
    const src = new SentrySource(config({ resolveOnCompleted: true, statusWriteback: { failed: 'gave up' } }), fetchImpl);
    const result = await src.writeBack('backend#42', 'failed');
    expect(result).toEqual({ written: true, code: 'written', value: 'noted (left unresolved)' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false); // the footgun: failed never resolves
  });

  it('writeBack failed → skipped (no calls) when not configured', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({}));
    const result = await new SentrySource(config(), fetchImpl).writeBack('backend#42', 'failed');
    expect(result).toEqual({ written: false, code: 'skipped', reason: "no 'failed' writeback configured" });
    expect(calls).toHaveLength(0);
  });

  it('writeBack → not-found on a 404 note; not-found on a malformed id (no calls)', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 404, json: { detail: 'gone' } }));
    expect((await new SentrySource(config(), fetchImpl).writeBack('backend#9', 'completed')).code).toBe('not-found');

    const { fetchImpl: f2, calls } = makeFetch(() => ({}));
    const bad = await new SentrySource(config(), f2).writeBack('not-an-id', 'completed');
    expect(bad.code).toBe('not-found');
    expect(calls).toHaveLength(0);
  });

  it('writeBack → error when the resolve fails after a successful note (partial is observable)', async () => {
    const { fetchImpl } = makeFetch((req) => (req.method === 'PUT' ? { status: 500, json: { detail: 'boom' } } : {}));
    const src = new SentrySource(config({ resolveOnCompleted: true }), fetchImpl);
    const result = await src.writeBack('backend#42', 'completed');
    expect(result.code).toBe('error'); // note landed, resolve failed → surfaced, not swallowed
  });

  it('checkConnection reports the org/project it reached', async () => {
    const { fetchImpl } = makeFetch((req) => (req.url.includes('/issues/?') ? { json: [rawIssue(1)] } : {}));
    const result = await new SentrySource(config(), fetchImpl).checkConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('acme/backend');
  });
});
