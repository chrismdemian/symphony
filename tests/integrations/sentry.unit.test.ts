import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SentryConnector,
  sentryLevelToPriority,
  createSentryConnectorFromDisk,
} from '../../src/integrations/sentry.js';
import {
  defaultSentryConfig,
  loadSentryConfig,
  saveSentryConfig,
  SentryConfigError,
  type SentryConfig,
} from '../../src/integrations/sentry-config.js';
import {
  SentryApiError,
  type SentryClientLike,
  type SentryIssueNode,
} from '../../src/integrations/sentry-client.js';
import { saveToken } from '../../src/integrations/secrets.js';

function node(over: Partial<SentryIssueNode>): SentryIssueNode {
  return {
    project: 'backend',
    id: '100',
    shortId: 'BACKEND-1',
    title: 'TypeError: boom',
    culprit: 'app/handler',
    permalink: 'https://sentry.io/organizations/acme/issues/100/',
    status: 'unresolved',
    level: 'error',
    lastSeen: '2026-06-08T00:00:00Z',
    assignee: null,
    ...over,
  };
}

interface FakeClient extends SentryClientLike {
  readonly noteCalls: { id: string; text: string }[];
  readonly resolveCalls: string[];
  readonly listCalls: { project: string; limit: number }[];
}

function fakeClient(opts: {
  issuesByProject?: Record<string, SentryIssueNode[]>;
  search?: SentryIssueNode[];
  noteError?: Error;
  resolveError?: Error;
  listError?: (project: string) => Error | undefined;
}): FakeClient {
  const noteCalls: FakeClient['noteCalls'] = [];
  const resolveCalls: FakeClient['resolveCalls'] = [];
  const listCalls: FakeClient['listCalls'] = [];
  return {
    noteCalls,
    resolveCalls,
    listCalls,
    listUnresolvedIssues: async (project, limit) => {
      listCalls.push({ project, limit });
      const err = opts.listError?.(project);
      if (err) throw err;
      return opts.issuesByProject?.[project] ?? [];
    },
    searchIssues: async () => opts.search ?? [],
    addNote: async (id, text) => {
      if (opts.noteError) throw opts.noteError;
      noteCalls.push({ id, text });
    },
    resolveIssue: async (id) => {
      if (opts.resolveError) throw opts.resolveError;
      resolveCalls.push(id);
    },
  };
}

function connector(client: SentryClientLike, config?: SentryConfig): SentryConnector {
  return new SentryConnector({
    client,
    config: config ?? { ...defaultSentryConfig(), org: 'acme', projects: ['backend'] },
    sleep: () => Promise.resolve(),
  });
}

describe('sentryLevelToPriority', () => {
  it('maps error levels (higher = sooner)', () => {
    expect(sentryLevelToPriority('fatal')).toBe(3);
    expect(sentryLevelToPriority('error')).toBe(2);
    expect(sentryLevelToPriority('warning')).toBe(1);
    expect(sentryLevelToPriority('info')).toBe(0);
    expect(sentryLevelToPriority(null)).toBe(0);
    expect(sentryLevelToPriority('ERROR')).toBe(2); // case-insensitive
  });
});

describe('SentryConnector.fetchOpenIssues', () => {
  it('maps nodes → NormalizedIssue with project#id ids, level pseudo-label, routing', async () => {
    const c = connector(
      fakeClient({
        issuesByProject: {
          backend: [node({ id: '42', title: 'Login broken', level: 'fatal', assignee: 'dana' })],
        },
      }),
    );
    const issues = await c.fetchOpenIssues();
    expect(issues).toHaveLength(1);
    const a = issues[0]!;
    expect(a.externalId).toBe('backend#42');
    expect(a.title).toBe('Login broken');
    expect(a.state).toBe('unresolved');
    expect(a.isTerminal).toBe(false);
    expect(a.priority).toBe(3);
    expect(a.labels).toEqual(['fatal']); // level surfaced for --label filtering
    expect(a.projectValue).toBe('backend');
    expect(a.assignee).toBe('dana');
    expect(a.body).toBe('app/handler');
    expect(a.url).toBe('https://sentry.io/organizations/acme/issues/100/');
  });

  it('classifies resolved / ignored issues as terminal', async () => {
    const c = connector(
      fakeClient({
        issuesByProject: {
          backend: [node({ id: '1', status: 'resolved' }), node({ id: '2', status: 'ignored' })],
        },
      }),
    );
    const issues = await c.fetchOpenIssues();
    expect(issues.map((i) => i.isTerminal)).toEqual([true, true]);
  });

  it('fetches and concatenates across multiple projects', async () => {
    const config = { ...defaultSentryConfig(), org: 'acme', projects: ['backend', 'frontend'] };
    const client = fakeClient({
      issuesByProject: {
        backend: [node({ project: 'backend', id: '1' })],
        frontend: [node({ project: 'frontend', id: '7' })],
      },
    });
    const issues = await connector(client, config).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['backend#1', 'frontend#7']);
  });

  it('skips a project that errors but keeps the others', async () => {
    const config = { ...defaultSentryConfig(), org: 'acme', projects: ['backend', 'secret'] };
    const client = fakeClient({
      issuesByProject: { backend: [node({ project: 'backend', id: '1' })] },
      listError: (p) => (p === 'secret' ? new SentryApiError('forbidden', 403) : undefined),
    });
    const issues = await connector(client, config).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['backend#1']);
  });

  it('throws only when EVERY project fails', async () => {
    const config = { ...defaultSentryConfig(), org: 'acme', projects: ['a', 'b'] };
    const client = fakeClient({ listError: () => new SentryApiError('401', 401) });
    await expect(connector(client, config).fetchOpenIssues()).rejects.toBeInstanceOf(SentryApiError);
  });

  it('falls back to a placeholder title for blank titles', async () => {
    const c = connector(
      fakeClient({ issuesByProject: { backend: [node({ id: '9', title: '  ', shortId: 'BACKEND-9' })] } }),
    );
    const [a] = await c.fetchOpenIssues();
    expect(a!.title).toBe('(untitled Sentry issue BACKEND-9)');
  });
});

describe('SentryConnector.writeBackStatus', () => {
  it('completed → posts the default note and does NOT resolve by default', async () => {
    const client = fakeClient({});
    const r = await connector(client).writeBackStatus('backend#42', 'completed');
    expect(r).toMatchObject({ written: true, code: 'written', value: 'noted (left unresolved)' });
    expect(client.noteCalls).toEqual([{ id: '42', text: 'Investigated by Symphony.' }]);
    expect(client.resolveCalls).toEqual([]);
  });

  it('completed → ALSO resolves when resolveOnCompleted is set', async () => {
    const config = {
      ...defaultSentryConfig(),
      org: 'acme',
      projects: ['backend'],
      resolveOnCompleted: true,
    };
    const client = fakeClient({});
    const r = await connector(client, config).writeBackStatus('backend#42', 'completed');
    expect(r).toMatchObject({ written: true, value: 'noted + resolved' });
    expect(client.noteCalls).toHaveLength(1);
    expect(client.resolveCalls).toEqual(['42']);
  });

  it('completed → honors a configured completion note', async () => {
    const config = {
      ...defaultSentryConfig(),
      org: 'acme',
      projects: ['backend'],
      statusWriteback: { completed: 'Triaged.' },
    };
    const client = fakeClient({});
    await connector(client, config).writeBackStatus('backend#42', 'completed');
    expect(client.noteCalls[0]!.text).toBe('Triaged.');
    expect(client.resolveCalls).toEqual([]);
  });

  it('failed → skipped when no failed writeback is configured', async () => {
    const client = fakeClient({});
    const r = await connector(client).writeBackStatus('backend#42', 'failed');
    expect(r).toMatchObject({ written: false, code: 'skipped' });
    expect(client.noteCalls).toEqual([]);
    expect(client.resolveCalls).toEqual([]);
  });

  it('failed → notes but NEVER resolves when configured', async () => {
    const config = {
      ...defaultSentryConfig(),
      org: 'acme',
      projects: ['backend'],
      resolveOnCompleted: true, // even with resolve on, failure must not resolve
      statusWriteback: { failed: 'Could not finish.' },
    };
    const client = fakeClient({});
    const r = await connector(client, config).writeBackStatus('backend#42', 'failed');
    expect(r).toMatchObject({ written: true, value: 'noted (left unresolved)' });
    expect(client.resolveCalls).toEqual([]);
  });

  it('not-found for a malformed external id', async () => {
    const r = await connector(fakeClient({})).writeBackStatus('not-an-id', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('not-found when the API returns 404', async () => {
    const client = fakeClient({ noteError: new SentryApiError('gone', 404) });
    const r = await connector(client).writeBackStatus('backend#42', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('error on a non-404 API failure', async () => {
    const client = fakeClient({ noteError: new SentryApiError('server error', 500) });
    const r = await connector(client).writeBackStatus('backend#42', 'completed');
    expect(r).toMatchObject({ written: false, code: 'error' });
  });
});

describe('SentryConnector.checkConnection', () => {
  it('ok with the first project reachable', async () => {
    const r = await connector(
      fakeClient({ issuesByProject: { backend: [node({})] } }),
    ).checkConnection();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('acme/backend');
  });

  it('fails gracefully when the client throws', async () => {
    const client = fakeClient({ listError: () => new SentryApiError('Sentry auth failed (401)', 401) });
    const r = await connector(client).checkConnection();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
  });

  it('reports when no projects are configured', async () => {
    const config = { ...defaultSentryConfig(), org: 'acme', projects: [] };
    const r = await connector(fakeClient({}), config).checkConnection();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('no projects');
  });
});

describe('sentry-config', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('round-trips through disk and UNIONS projects across patches', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-sentry-cfg-'));
    expect(await loadSentryConfig(home)).toBeUndefined();
    await saveSentryConfig({ org: 'acme', projects: ['backend'], baseUrl: 'https://sentry.io' }, home);
    const merged = await saveSentryConfig(
      { projects: ['frontend'], statusWriteback: { failed: 'oops' }, resolveOnCompleted: true },
      home,
    );
    expect(merged.projects).toEqual(['backend', 'frontend']);
    expect(merged.statusWriteback.failed).toBe('oops');
    expect(merged.org).toBe('acme');
    expect(merged.resolveOnCompleted).toBe(true);
  });

  it('rejects a non-https baseUrl but allows localhost http', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-sentry-cfg-'));
    await expect(
      saveSentryConfig({ org: 'acme', projects: ['backend'], baseUrl: 'http://evil.example.com' }, home),
    ).rejects.toBeTruthy();
    const ok = await saveSentryConfig(
      { org: 'acme', projects: ['backend'], baseUrl: 'http://localhost:9000' },
      home,
    );
    expect(ok.baseUrl).toBe('http://localhost:9000');
  });

  it('throws SentryConfigError on malformed JSON', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-sentry-cfg-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { integrationsDir } = await import('../../src/integrations/secrets.js');
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'sentry.json'), '{ not json', 'utf8');
    await expect(loadSentryConfig(home)).rejects.toBeInstanceOf(SentryConfigError);
  });
});

describe('createSentryConnectorFromDisk', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('returns undefined when no token is stored', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-sentry-disk-'));
    await saveSentryConfig({ org: 'acme', projects: ['backend'] }, home);
    expect(await createSentryConnectorFromDisk({ home })).toBeUndefined();
  });

  it('returns undefined when a token is stored but no org is configured', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-sentry-disk-'));
    await saveToken('sentry', 'sntry-token', home);
    await saveSentryConfig({ projects: ['backend'] }, home);
    expect(await createSentryConnectorFromDisk({ home })).toBeUndefined();
  });

  it('returns undefined when a token + org are present but no projects', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-sentry-disk-'));
    await saveToken('sentry', 'sntry-token', home);
    await saveSentryConfig({ org: 'acme' }, home);
    expect(await createSentryConnectorFromDisk({ home })).toBeUndefined();
  });

  it('constructs a connector when token + org + projects are present (lazy — no network)', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-sentry-disk-'));
    await saveToken('sentry', 'sntry-token', home);
    await saveSentryConfig({ org: 'acme', projects: ['backend'] }, home);
    const c = await createSentryConnectorFromDisk({ home });
    expect(c).toBeDefined();
    expect(c!.source).toBe('sentry');
  });
});
