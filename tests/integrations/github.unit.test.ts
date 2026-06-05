import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitHubConnector,
  githubLabelsToPriority,
  createGitHubConnectorFromDisk,
} from '../../src/integrations/github.js';
import {
  defaultGitHubConfig,
  loadGitHubConfig,
  saveGitHubConfig,
  GitHubConfigError,
  type GitHubConfig,
} from '../../src/integrations/github-config.js';
import {
  GitHubApiError,
  type GitHubClientLike,
  type GitHubIssueNode,
} from '../../src/integrations/github-client.js';
import { saveToken } from '../../src/integrations/secrets.js';

function node(over: Partial<GitHubIssueNode>): GitHubIssueNode {
  return {
    repo: 'acme/app',
    id: 1,
    number: 1,
    title: 'Fix the bug',
    body: 'details',
    state: 'open',
    htmlUrl: 'https://github.com/acme/app/issues/1',
    updatedAt: '2026-06-01T00:00:00Z',
    labels: [],
    assignee: null,
    ...over,
  };
}

interface FakeClient extends GitHubClientLike {
  readonly commentCalls: { repo: string; number: number; body: string }[];
  readonly closeCalls: { repo: string; number: number }[];
  readonly listCalls: { repo: string; limit: number }[];
}

function fakeClient(opts: {
  /** Issues keyed by repo slug (so multi-repo fetch can be exercised). */
  issuesByRepo?: Record<string, GitHubIssueNode[]>;
  search?: GitHubIssueNode[];
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
    getViewer: async () => opts.viewer ?? { login: 'octocat' },
  };
}

function connector(client: GitHubClientLike, config?: GitHubConfig): GitHubConnector {
  // No real sleep — instant throttle for tests.
  return new GitHubConnector({
    client,
    config: config ?? { ...defaultGitHubConfig(), repos: ['acme/app'] },
    sleep: () => Promise.resolve(),
  });
}

describe('githubLabelsToPriority', () => {
  it('maps conventional priority labels to integers (higher = sooner)', () => {
    expect(githubLabelsToPriority([])).toBe(0);
    expect(githubLabelsToPriority(['bug', 'urgent'])).toBe(3);
    expect(githubLabelsToPriority(['priority: critical'])).toBe(3);
    expect(githubLabelsToPriority(['P1'])).toBe(3);
    expect(githubLabelsToPriority(['high'])).toBe(2);
    expect(githubLabelsToPriority(['priority/medium'])).toBe(1);
    expect(githubLabelsToPriority(['low'])).toBe(0);
    expect(githubLabelsToPriority(['enhancement'])).toBe(0);
    // Highest across all labels wins, order-independent.
    expect(githubLabelsToPriority(['low', 'urgent'])).toBe(3);
    expect(githubLabelsToPriority(['urgent', 'low'])).toBe(3);
    // No false positive on a word that merely CONTAINS a keyword.
    expect(githubLabelsToPriority(['highlighting'])).toBe(0);
  });
});

describe('GitHubConnector.fetchOpenIssues', () => {
  it('maps nodes → NormalizedIssue with owner/repo#number ids + routing', async () => {
    const c = connector(
      fakeClient({
        issuesByRepo: {
          'acme/app': [
            node({
              repo: 'acme/app',
              number: 42,
              title: 'Open one',
              labels: ['high'],
              assignee: 'dana',
            }),
          ],
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
    expect(a.priority).toBe(2); // high → 2
    expect(a.projectValue).toBe('acme/app');
    expect(a.assignee).toBe('dana');
    expect(a.url).toBe('https://github.com/acme/app/issues/1');
  });

  it('classifies closed issues as terminal', async () => {
    const c = connector(
      fakeClient({ issuesByRepo: { 'acme/app': [node({ state: 'closed' })] } }),
    );
    const [a] = await c.fetchOpenIssues();
    expect(a!.isTerminal).toBe(true);
  });

  it('fetches and concatenates across multiple repos', async () => {
    const config = { ...defaultGitHubConfig(), repos: ['acme/app', 'acme/api'] };
    const client = fakeClient({
      issuesByRepo: {
        'acme/app': [node({ repo: 'acme/app', number: 1 })],
        'acme/api': [node({ repo: 'acme/api', number: 7 })],
      },
    });
    const issues = await connector(client, config).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['acme/app#1', 'acme/api#7']);
    expect(client.listCalls.map((c) => c.repo)).toEqual(['acme/app', 'acme/api']);
  });

  it('skips a repo that errors but keeps the others (token can\'t see one repo)', async () => {
    const config = { ...defaultGitHubConfig(), repos: ['acme/app', 'private/repo'] };
    const client = fakeClient({
      issuesByRepo: { 'acme/app': [node({ repo: 'acme/app', number: 1 })] },
      listError: (repo) =>
        repo === 'private/repo' ? new GitHubApiError('not found', 404) : undefined,
    });
    const issues = await connector(client, config).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['acme/app#1']);
  });

  it('throws only when EVERY repo fails (so the tool surfaces a real failure)', async () => {
    const config = { ...defaultGitHubConfig(), repos: ['a/b', 'c/d'] };
    const client = fakeClient({ listError: () => new GitHubApiError('401', 401) });
    await expect(connector(client, config).fetchOpenIssues()).rejects.toBeInstanceOf(GitHubApiError);
  });

  it('falls back to a placeholder title for blank titles', async () => {
    const c = connector(
      fakeClient({ issuesByRepo: { 'acme/app': [node({ number: 9, title: '   ' })] } }),
    );
    const [a] = await c.fetchOpenIssues();
    expect(a!.title).toBe('(untitled GitHub issue acme/app#9)');
  });
});

describe('GitHubConnector.writeBackStatus', () => {
  it('completed → comments (default) then closes', async () => {
    const client = fakeClient({});
    const r = await connector(client).writeBackStatus('acme/app#42', 'completed');
    expect(r).toMatchObject({ written: true, code: 'written', value: 'commented + closed' });
    expect(client.commentCalls).toEqual([
      { repo: 'acme/app', number: 42, body: 'Completed by Symphony.' },
    ]);
    expect(client.closeCalls).toEqual([{ repo: 'acme/app', number: 42 }]);
  });

  it('completed → honors a configured completion comment', async () => {
    const config = { ...defaultGitHubConfig(), repos: ['acme/app'], statusWriteback: { completed: 'Shipped! 🚀' } };
    const client = fakeClient({});
    await connector(client, config).writeBackStatus('acme/app#42', 'completed');
    expect(client.commentCalls[0]!.body).toBe('Shipped! 🚀');
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
    const config = { ...defaultGitHubConfig(), repos: ['acme/app'], statusWriteback: { failed: 'Symphony could not finish this.' } };
    const client = fakeClient({});
    const r = await connector(client, config).writeBackStatus('acme/app#42', 'failed');
    expect(r).toMatchObject({ written: true, value: 'commented (left open)' });
    expect(client.commentCalls[0]!.body).toBe('Symphony could not finish this.');
    expect(client.closeCalls).toEqual([]); // never closes on failure
  });

  it('not-found for a malformed external id', async () => {
    const r = await connector(fakeClient({})).writeBackStatus('not-an-id', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('not-found when the API returns 404', async () => {
    const client = fakeClient({ commentError: new GitHubApiError('gone', 404) });
    const r = await connector(client).writeBackStatus('acme/app#42', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('error on a non-404 API failure', async () => {
    const client = fakeClient({ commentError: new GitHubApiError('server error', 500) });
    const r = await connector(client).writeBackStatus('acme/app#42', 'completed');
    expect(r).toMatchObject({ written: false, code: 'error' });
  });
});

describe('GitHubConnector.checkConnection', () => {
  it('ok with the viewer login', async () => {
    const r = await connector(fakeClient({ viewer: { login: 'chris' } })).checkConnection();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('chris');
  });

  it('fails gracefully when the client throws', async () => {
    const client = fakeClient({});
    client.getViewer = async () => {
      throw new GitHubApiError('GitHub auth failed (401)', 401);
    };
    const r = await connector(client).checkConnection();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
  });
});

describe('github-config', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('round-trips through disk and UNIONS repos across patches', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-github-cfg-'));
    expect(await loadGitHubConfig(home)).toBeUndefined();
    await saveGitHubConfig({ repos: ['acme/app'] }, home);
    const merged = await saveGitHubConfig(
      { repos: ['acme/api'], statusWriteback: { failed: 'oops' } },
      home,
    );
    expect(merged.repos).toEqual(['acme/app', 'acme/api']);
    expect(merged.statusWriteback.failed).toBe('oops');
  });

  it('de-dups repos case-insensitively on union', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-github-cfg-'));
    await saveGitHubConfig({ repos: ['Acme/App'] }, home);
    const merged = await saveGitHubConfig({ repos: ['acme/app'] }, home);
    expect(merged.repos).toEqual(['Acme/App']);
  });

  it('replaceRepos overwrites instead of unioning', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-github-cfg-'));
    await saveGitHubConfig({ repos: ['a/b'] }, home);
    const merged = await saveGitHubConfig({ repos: ['c/d'], replaceRepos: true }, home);
    expect(merged.repos).toEqual(['c/d']);
  });

  it('rejects a malformed repo slug', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-github-cfg-'));
    await expect(saveGitHubConfig({ repos: ['not-a-slug'] }, home)).rejects.toBeTruthy();
  });

  it('rejects a non-https apiBaseUrl (token-leak surface) but allows localhost http', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-github-cfg-'));
    await expect(
      saveGitHubConfig({ repos: ['a/b'], apiBaseUrl: 'http://evil.example.com' }, home),
    ).rejects.toBeTruthy();
    const https = await saveGitHubConfig(
      { repos: ['a/b'], apiBaseUrl: 'https://github.acme.com/api/v3' },
      home,
    );
    expect(https.apiBaseUrl).toBe('https://github.acme.com/api/v3');
    const local = await saveGitHubConfig(
      { repos: ['a/b'], apiBaseUrl: 'http://localhost:3000/api/v3', replaceRepos: true },
      home,
    );
    expect(local.apiBaseUrl).toBe('http://localhost:3000/api/v3');
  });

  it('throws GitHubConfigError on malformed JSON', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-github-cfg-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { integrationsDir } = await import('../../src/integrations/secrets.js');
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'github.json'), '{ not json', 'utf8');
    await expect(loadGitHubConfig(home)).rejects.toBeInstanceOf(GitHubConfigError);
  });
});

describe('createGitHubConnectorFromDisk', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('returns undefined when no token is stored', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-github-disk-'));
    await saveGitHubConfig({ repos: ['acme/app'] }, home);
    expect(await createGitHubConnectorFromDisk({ home })).toBeUndefined();
  });

  it('returns undefined when a token is stored but no repos are configured', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-github-disk-'));
    await saveToken('github', 'ghp_token', home);
    expect(await createGitHubConnectorFromDisk({ home })).toBeUndefined();
  });

  it('constructs a connector when token AND repos are present (lazy — no network)', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-github-disk-'));
    await saveToken('github', 'ghp_token', home);
    await saveGitHubConfig({ repos: ['acme/app'] }, home);
    const c = await createGitHubConnectorFromDisk({ home });
    expect(c).toBeDefined();
    expect(c!.source).toBe('github');
  });
});
