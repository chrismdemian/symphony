import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ForgejoConnector,
  forgejoLabelsToPriority,
  createForgejoConnectorFromDisk,
} from '../../src/integrations/forgejo.js';
import {
  defaultForgejoConfig,
  loadForgejoConfig,
  saveForgejoConfig,
  ForgejoConfigError,
  type ForgejoConfig,
} from '../../src/integrations/forgejo-config.js';
import {
  ForgejoApiError,
  type ForgejoClientLike,
  type ForgejoIssueNode,
} from '../../src/integrations/forgejo-client.js';
import { saveToken } from '../../src/integrations/secrets.js';

function node(over: Partial<ForgejoIssueNode>): ForgejoIssueNode {
  return {
    repo: 'acme/app',
    id: 1,
    number: 1,
    title: 'Fix the bug',
    body: 'details',
    state: 'open',
    htmlUrl: 'https://code.acme.com/acme/app/issues/1',
    updatedAt: '2026-06-01T00:00:00Z',
    labels: [],
    assignee: null,
    ...over,
  };
}

interface FakeClient extends ForgejoClientLike {
  readonly commentCalls: { repo: string; number: number; body: string }[];
  readonly closeCalls: { repo: string; number: number }[];
  readonly listCalls: { repo: string; limit: number }[];
}

function fakeClient(opts: {
  issuesByRepo?: Record<string, ForgejoIssueNode[]>;
  search?: ForgejoIssueNode[];
  viewer?: { login: string } | null;
  commentError?: Error;
  closeError?: Error;
  listError?: (repo: string) => Error | undefined;
}): FakeClient {
  const commentCalls: FakeClient['commentCalls'] = [];
  const closeCalls: FakeClient['closeCalls'] = [];
  const listCalls: FakeClient['listCalls'] = [];
  return {
    commentCalls,
    closeCalls,
    listCalls,
    listOpenIssues: async (repo, limit) => {
      listCalls.push({ repo, limit });
      const err = opts.listError?.(repo);
      if (err) throw err;
      return opts.issuesByRepo?.[repo] ?? [];
    },
    searchIssues: async () => opts.search ?? [],
    addComment: async (repo, number, body) => {
      if (opts.commentError) throw opts.commentError;
      commentCalls.push({ repo, number, body });
    },
    closeIssue: async (repo, number) => {
      if (opts.closeError) throw opts.closeError;
      closeCalls.push({ repo, number });
    },
    getViewer: async () => opts.viewer ?? { login: 'forgejo-user' },
  };
}

function connector(client: ForgejoClientLike, config?: ForgejoConfig): ForgejoConnector {
  return new ForgejoConnector({
    client,
    config: config ?? { ...defaultForgejoConfig(), siteUrl: 'https://code.acme.com', repos: ['acme/app'] },
    sleep: () => Promise.resolve(),
  });
}

describe('forgejoLabelsToPriority', () => {
  it('maps conventional + scoped priority labels (higher = sooner)', () => {
    expect(forgejoLabelsToPriority([])).toBe(0);
    expect(forgejoLabelsToPriority(['urgent'])).toBe(3);
    expect(forgejoLabelsToPriority(['priority/critical'])).toBe(3);
    expect(forgejoLabelsToPriority(['P1'])).toBe(3);
    expect(forgejoLabelsToPriority(['priority/high'])).toBe(2);
    expect(forgejoLabelsToPriority(['medium'])).toBe(1);
    expect(forgejoLabelsToPriority(['priority/low'])).toBe(0);
    expect(forgejoLabelsToPriority(['low', 'urgent'])).toBe(3);
    expect(forgejoLabelsToPriority(['highlighting'])).toBe(0);
  });
});

describe('ForgejoConnector.fetchOpenIssues', () => {
  it('maps nodes → NormalizedIssue with owner/repo#number ids + routing', async () => {
    const c = connector(
      fakeClient({
        issuesByRepo: {
          'acme/app': [node({ number: 42, title: 'Open one', labels: ['priority/high'], assignee: 'dana' })],
        },
      }),
    );
    const issues = await c.fetchOpenIssues();
    expect(issues).toHaveLength(1);
    const a = issues[0]!;
    expect(a.externalId).toBe('acme/app#42');
    expect(a.title).toBe('Open one');
    expect(a.state).toBe('open');
    expect(a.isTerminal).toBe(false);
    expect(a.priority).toBe(2);
    expect(a.projectValue).toBe('acme/app');
    expect(a.assignee).toBe('dana');
  });

  it('classifies closed issues as terminal', async () => {
    const c = connector(fakeClient({ issuesByRepo: { 'acme/app': [node({ state: 'closed' })] } }));
    const [a] = await c.fetchOpenIssues();
    expect(a!.isTerminal).toBe(true);
  });

  it('fetches and concatenates across multiple repos', async () => {
    const config = {
      ...defaultForgejoConfig(),
      siteUrl: 'https://code.acme.com',
      repos: ['acme/app', 'acme/api'],
    };
    const client = fakeClient({
      issuesByRepo: {
        'acme/app': [node({ repo: 'acme/app', number: 1 })],
        'acme/api': [node({ repo: 'acme/api', number: 7 })],
      },
    });
    const issues = await connector(client, config).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['acme/app#1', 'acme/api#7']);
  });

  it('skips a repo that errors but keeps the others', async () => {
    const config = {
      ...defaultForgejoConfig(),
      siteUrl: 'https://code.acme.com',
      repos: ['acme/app', 'private/repo'],
    };
    const client = fakeClient({
      issuesByRepo: { 'acme/app': [node({ repo: 'acme/app', number: 1 })] },
      listError: (r) => (r === 'private/repo' ? new ForgejoApiError('not found', 404) : undefined),
    });
    const issues = await connector(client, config).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['acme/app#1']);
  });

  it('throws only when EVERY repo fails', async () => {
    const config = {
      ...defaultForgejoConfig(),
      siteUrl: 'https://code.acme.com',
      repos: ['a/b', 'c/d'],
    };
    const client = fakeClient({ listError: () => new ForgejoApiError('401', 401) });
    await expect(connector(client, config).fetchOpenIssues()).rejects.toBeInstanceOf(ForgejoApiError);
  });

  it('falls back to a placeholder title for blank titles', async () => {
    const c = connector(fakeClient({ issuesByRepo: { 'acme/app': [node({ number: 9, title: '  ' })] } }));
    const [a] = await c.fetchOpenIssues();
    expect(a!.title).toBe('(untitled Forgejo issue acme/app#9)');
  });
});

describe('ForgejoConnector.writeBackStatus', () => {
  it('completed → comments (default) then closes (uses number)', async () => {
    const client = fakeClient({});
    const r = await connector(client).writeBackStatus('acme/app#42', 'completed');
    expect(r).toMatchObject({ written: true, code: 'written', value: 'commented + closed' });
    expect(client.commentCalls).toEqual([{ repo: 'acme/app', number: 42, body: 'Completed by Symphony.' }]);
    expect(client.closeCalls).toEqual([{ repo: 'acme/app', number: 42 }]);
  });

  it('completed → honors a configured completion comment', async () => {
    const config = {
      ...defaultForgejoConfig(),
      siteUrl: 'https://code.acme.com',
      repos: ['acme/app'],
      statusWriteback: { completed: 'Shipped!' },
    };
    const client = fakeClient({});
    await connector(client, config).writeBackStatus('acme/app#42', 'completed');
    expect(client.commentCalls[0]!.body).toBe('Shipped!');
    expect(client.closeCalls).toHaveLength(1);
  });

  it('failed → skipped when no failed writeback is configured', async () => {
    const client = fakeClient({});
    const r = await connector(client).writeBackStatus('acme/app#42', 'failed');
    expect(r).toMatchObject({ written: false, code: 'skipped' });
    expect(client.commentCalls).toEqual([]);
    expect(client.closeCalls).toEqual([]);
  });

  it('failed → comments but never closes when configured', async () => {
    const config = {
      ...defaultForgejoConfig(),
      siteUrl: 'https://code.acme.com',
      repos: ['acme/app'],
      statusWriteback: { failed: 'Could not finish.' },
    };
    const client = fakeClient({});
    const r = await connector(client, config).writeBackStatus('acme/app#42', 'failed');
    expect(r).toMatchObject({ written: true, value: 'commented (left open)' });
    expect(client.closeCalls).toEqual([]);
  });

  it('not-found for a malformed external id', async () => {
    const r = await connector(fakeClient({})).writeBackStatus('not-an-id', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('not-found when the API returns 404', async () => {
    const client = fakeClient({ commentError: new ForgejoApiError('gone', 404) });
    const r = await connector(client).writeBackStatus('acme/app#42', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('error on a non-404 API failure', async () => {
    const client = fakeClient({ commentError: new ForgejoApiError('server error', 500) });
    const r = await connector(client).writeBackStatus('acme/app#42', 'completed');
    expect(r).toMatchObject({ written: false, code: 'error' });
  });
});

describe('ForgejoConnector.checkConnection', () => {
  it('ok with the viewer login', async () => {
    const r = await connector(fakeClient({ viewer: { login: 'chris' } })).checkConnection();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('chris');
  });

  it('fails gracefully when the client throws', async () => {
    const client = fakeClient({});
    client.getViewer = async () => {
      throw new ForgejoApiError('Forgejo auth failed (401)', 401);
    };
    const r = await connector(client).checkConnection();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
  });
});

describe('forgejo-config', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('round-trips through disk and UNIONS repos across patches', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-forgejo-cfg-'));
    expect(await loadForgejoConfig(home)).toBeUndefined();
    await saveForgejoConfig({ repos: ['acme/app'], siteUrl: 'https://code.acme.com' }, home);
    const merged = await saveForgejoConfig({ repos: ['acme/api'], statusWriteback: { failed: 'oops' } }, home);
    expect(merged.repos).toEqual(['acme/app', 'acme/api']);
    expect(merged.statusWriteback.failed).toBe('oops');
    expect(merged.siteUrl).toBe('https://code.acme.com');
  });

  it('rejects a malformed repo slug (no slash)', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-forgejo-cfg-'));
    await expect(saveForgejoConfig({ repos: ['noslug'] }, home)).rejects.toBeTruthy();
  });

  it('rejects a non-https siteUrl but allows localhost http', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-forgejo-cfg-'));
    await expect(
      saveForgejoConfig({ repos: ['a/b'], siteUrl: 'http://evil.example.com' }, home),
    ).rejects.toBeTruthy();
    const ok = await saveForgejoConfig({ repos: ['a/b'], siteUrl: 'https://code.acme.com' }, home);
    expect(ok.siteUrl).toBe('https://code.acme.com');
  });

  it('throws ForgejoConfigError on malformed JSON', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-forgejo-cfg-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { integrationsDir } = await import('../../src/integrations/secrets.js');
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'forgejo.json'), '{ not json', 'utf8');
    await expect(loadForgejoConfig(home)).rejects.toBeInstanceOf(ForgejoConfigError);
  });
});

describe('createForgejoConnectorFromDisk', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('returns undefined when no token is stored', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-forgejo-disk-'));
    await saveForgejoConfig({ repos: ['acme/app'], siteUrl: 'https://code.acme.com' }, home);
    expect(await createForgejoConnectorFromDisk({ home })).toBeUndefined();
  });

  it('returns undefined when a token is stored but no site URL is configured', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-forgejo-disk-'));
    await saveToken('forgejo', 'fj-token', home);
    await saveForgejoConfig({ repos: ['acme/app'] }, home);
    expect(await createForgejoConnectorFromDisk({ home })).toBeUndefined();
  });

  it('returns undefined when a token + site URL are present but no repos', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-forgejo-disk-'));
    await saveToken('forgejo', 'fj-token', home);
    await saveForgejoConfig({ siteUrl: 'https://code.acme.com' }, home);
    expect(await createForgejoConnectorFromDisk({ home })).toBeUndefined();
  });

  it('constructs a connector when token + site URL + repos are present (lazy — no network)', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-forgejo-disk-'));
    await saveToken('forgejo', 'fj-token', home);
    await saveForgejoConfig({ siteUrl: 'https://code.acme.com', repos: ['acme/app'] }, home);
    const c = await createForgejoConnectorFromDisk({ home });
    expect(c).toBeDefined();
    expect(c!.source).toBe('forgejo');
  });
});
