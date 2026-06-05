import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GitLabConnector,
  gitlabLabelsToPriority,
  createGitLabConnectorFromDisk,
} from '../../src/integrations/gitlab.js';
import {
  defaultGitLabConfig,
  loadGitLabConfig,
  saveGitLabConfig,
  GitLabConfigError,
  type GitLabConfig,
} from '../../src/integrations/gitlab-config.js';
import {
  GitLabApiError,
  type GitLabClientLike,
  type GitLabIssueNode,
} from '../../src/integrations/gitlab-client.js';
import { saveToken } from '../../src/integrations/secrets.js';

function node(over: Partial<GitLabIssueNode>): GitLabIssueNode {
  return {
    projectPath: 'acme/app',
    id: 1,
    iid: 1,
    title: 'Fix the bug',
    body: 'details',
    state: 'opened',
    webUrl: 'https://gitlab.com/acme/app/-/issues/1',
    updatedAt: '2026-06-01T00:00:00Z',
    labels: [],
    assignee: null,
    ...over,
  };
}

interface FakeClient extends GitLabClientLike {
  readonly noteCalls: { projectPath: string; iid: number; body: string }[];
  readonly closeCalls: { projectPath: string; iid: number }[];
  readonly listCalls: { projectPath: string; limit: number }[];
}

function fakeClient(opts: {
  issuesByProject?: Record<string, GitLabIssueNode[]>;
  search?: GitLabIssueNode[];
  viewer?: { username: string } | null;
  noteError?: Error;
  closeError?: Error;
  listError?: (projectPath: string) => Error | undefined;
}): FakeClient {
  const noteCalls: FakeClient['noteCalls'] = [];
  const closeCalls: FakeClient['closeCalls'] = [];
  const listCalls: FakeClient['listCalls'] = [];
  return {
    noteCalls,
    closeCalls,
    listCalls,
    listOpenIssues: async (projectPath, limit) => {
      listCalls.push({ projectPath, limit });
      const err = opts.listError?.(projectPath);
      if (err) throw err;
      return opts.issuesByProject?.[projectPath] ?? [];
    },
    searchIssues: async () => opts.search ?? [],
    addNote: async (projectPath, iid, body) => {
      if (opts.noteError) throw opts.noteError;
      noteCalls.push({ projectPath, iid, body });
    },
    closeIssue: async (projectPath, iid) => {
      if (opts.closeError) throw opts.closeError;
      closeCalls.push({ projectPath, iid });
    },
    getViewer: async () => opts.viewer ?? { username: 'gitlab-user' },
  };
}

function connector(client: GitLabClientLike, config?: GitLabConfig): GitLabConnector {
  return new GitLabConnector({
    client,
    config: config ?? { ...defaultGitLabConfig(), projects: ['acme/app'] },
    sleep: () => Promise.resolve(),
  });
}

describe('gitlabLabelsToPriority', () => {
  it('maps conventional + scoped priority labels (higher = sooner)', () => {
    expect(gitlabLabelsToPriority([])).toBe(0);
    expect(gitlabLabelsToPriority(['urgent'])).toBe(3);
    expect(gitlabLabelsToPriority(['priority::critical'])).toBe(3);
    expect(gitlabLabelsToPriority(['P1'])).toBe(3);
    expect(gitlabLabelsToPriority(['priority::high'])).toBe(2);
    expect(gitlabLabelsToPriority(['medium'])).toBe(1);
    expect(gitlabLabelsToPriority(['priority::low'])).toBe(0);
    expect(gitlabLabelsToPriority(['low', 'urgent'])).toBe(3);
    expect(gitlabLabelsToPriority(['highlighting'])).toBe(0);
  });
});

describe('GitLabConnector.fetchOpenIssues', () => {
  it('maps nodes → NormalizedIssue with group/project#iid ids + routing', async () => {
    const c = connector(
      fakeClient({
        issuesByProject: {
          'acme/app': [node({ iid: 42, title: 'Open one', labels: ['priority::high'], assignee: 'dana' })],
        },
      }),
    );
    const issues = await c.fetchOpenIssues();
    expect(issues).toHaveLength(1);
    const a = issues[0]!;
    expect(a.externalId).toBe('acme/app#42');
    expect(a.title).toBe('Open one');
    expect(a.state).toBe('opened');
    expect(a.isTerminal).toBe(false);
    expect(a.priority).toBe(2);
    expect(a.projectValue).toBe('acme/app');
    expect(a.assignee).toBe('dana');
  });

  it('classifies closed issues as terminal', async () => {
    const c = connector(fakeClient({ issuesByProject: { 'acme/app': [node({ state: 'closed' })] } }));
    const [a] = await c.fetchOpenIssues();
    expect(a!.isTerminal).toBe(true);
  });

  it('fetches and concatenates across multiple projects', async () => {
    const config = { ...defaultGitLabConfig(), projects: ['acme/app', 'acme/api'] };
    const client = fakeClient({
      issuesByProject: {
        'acme/app': [node({ projectPath: 'acme/app', iid: 1 })],
        'acme/api': [node({ projectPath: 'acme/api', iid: 7 })],
      },
    });
    const issues = await connector(client, config).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['acme/app#1', 'acme/api#7']);
  });

  it("skips a project that errors but keeps the others", async () => {
    const config = { ...defaultGitLabConfig(), projects: ['acme/app', 'private/repo'] };
    const client = fakeClient({
      issuesByProject: { 'acme/app': [node({ projectPath: 'acme/app', iid: 1 })] },
      listError: (p) => (p === 'private/repo' ? new GitLabApiError('not found', 404) : undefined),
    });
    const issues = await connector(client, config).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['acme/app#1']);
  });

  it('throws only when EVERY project fails', async () => {
    const config = { ...defaultGitLabConfig(), projects: ['a/b', 'c/d'] };
    const client = fakeClient({ listError: () => new GitLabApiError('401', 401) });
    await expect(connector(client, config).fetchOpenIssues()).rejects.toBeInstanceOf(GitLabApiError);
  });

  it('falls back to a placeholder title for blank titles', async () => {
    const c = connector(fakeClient({ issuesByProject: { 'acme/app': [node({ iid: 9, title: '  ' })] } }));
    const [a] = await c.fetchOpenIssues();
    expect(a!.title).toBe('(untitled GitLab issue acme/app#9)');
  });
});

describe('GitLabConnector.writeBackStatus', () => {
  it('completed → notes (default) then closes (uses iid, not global id)', async () => {
    const client = fakeClient({});
    const r = await connector(client).writeBackStatus('acme/app#42', 'completed');
    expect(r).toMatchObject({ written: true, code: 'written', value: 'noted + closed' });
    expect(client.noteCalls).toEqual([{ projectPath: 'acme/app', iid: 42, body: 'Completed by Symphony.' }]);
    expect(client.closeCalls).toEqual([{ projectPath: 'acme/app', iid: 42 }]);
  });

  it('completed → honors a configured completion note', async () => {
    const config = { ...defaultGitLabConfig(), projects: ['acme/app'], statusWriteback: { completed: 'Shipped!' } };
    const client = fakeClient({});
    await connector(client, config).writeBackStatus('acme/app#42', 'completed');
    expect(client.noteCalls[0]!.body).toBe('Shipped!');
    expect(client.closeCalls).toHaveLength(1);
  });

  it('failed → skipped when no failed writeback is configured', async () => {
    const client = fakeClient({});
    const r = await connector(client).writeBackStatus('acme/app#42', 'failed');
    expect(r).toMatchObject({ written: false, code: 'skipped' });
    expect(client.noteCalls).toEqual([]);
    expect(client.closeCalls).toEqual([]);
  });

  it('failed → notes but never closes when configured', async () => {
    const config = { ...defaultGitLabConfig(), projects: ['acme/app'], statusWriteback: { failed: 'Could not finish.' } };
    const client = fakeClient({});
    const r = await connector(client, config).writeBackStatus('acme/app#42', 'failed');
    expect(r).toMatchObject({ written: true, value: 'noted (left open)' });
    expect(client.closeCalls).toEqual([]);
  });

  it('parses a subgroup path id correctly (splits on the last #)', async () => {
    const client = fakeClient({});
    await connector(client).writeBackStatus('acme/team/app#7', 'completed');
    expect(client.closeCalls).toEqual([{ projectPath: 'acme/team/app', iid: 7 }]);
  });

  it('not-found for a malformed external id', async () => {
    const r = await connector(fakeClient({})).writeBackStatus('not-an-id', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('not-found when the API returns 404', async () => {
    const client = fakeClient({ noteError: new GitLabApiError('gone', 404) });
    const r = await connector(client).writeBackStatus('acme/app#42', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('error on a non-404 API failure', async () => {
    const client = fakeClient({ noteError: new GitLabApiError('server error', 500) });
    const r = await connector(client).writeBackStatus('acme/app#42', 'completed');
    expect(r).toMatchObject({ written: false, code: 'error' });
  });
});

describe('GitLabConnector.checkConnection', () => {
  it('ok with the viewer username', async () => {
    const r = await connector(fakeClient({ viewer: { username: 'chris' } })).checkConnection();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('chris');
  });

  it('fails gracefully when the client throws', async () => {
    const client = fakeClient({});
    client.getViewer = async () => {
      throw new GitLabApiError('GitLab auth failed (401)', 401);
    };
    const r = await connector(client).checkConnection();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
  });
});

describe('gitlab-config', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('round-trips through disk and UNIONS projects across patches', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-gitlab-cfg-'));
    expect(await loadGitLabConfig(home)).toBeUndefined();
    await saveGitLabConfig({ projects: ['acme/app'] }, home);
    const merged = await saveGitLabConfig({ projects: ['acme/api'], statusWriteback: { failed: 'oops' } }, home);
    expect(merged.projects).toEqual(['acme/app', 'acme/api']);
    expect(merged.statusWriteback.failed).toBe('oops');
  });

  it('rejects a malformed project path (no slash)', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-gitlab-cfg-'));
    await expect(saveGitLabConfig({ projects: ['noslug'] }, home)).rejects.toBeTruthy();
  });

  it('rejects a non-https siteUrl but allows localhost http', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-gitlab-cfg-'));
    await expect(
      saveGitLabConfig({ projects: ['a/b'], siteUrl: 'http://evil.example.com' }, home),
    ).rejects.toBeTruthy();
    const ok = await saveGitLabConfig({ projects: ['a/b'], siteUrl: 'https://gitlab.acme.com' }, home);
    expect(ok.siteUrl).toBe('https://gitlab.acme.com');
  });

  it('throws GitLabConfigError on malformed JSON', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-gitlab-cfg-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { integrationsDir } = await import('../../src/integrations/secrets.js');
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'gitlab.json'), '{ not json', 'utf8');
    await expect(loadGitLabConfig(home)).rejects.toBeInstanceOf(GitLabConfigError);
  });
});

describe('createGitLabConnectorFromDisk', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('returns undefined when no token is stored', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-gitlab-disk-'));
    await saveGitLabConfig({ projects: ['acme/app'] }, home);
    expect(await createGitLabConnectorFromDisk({ home })).toBeUndefined();
  });

  it('returns undefined when a token is stored but no projects are configured', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-gitlab-disk-'));
    await saveToken('gitlab', 'glpat-token', home);
    expect(await createGitLabConnectorFromDisk({ home })).toBeUndefined();
  });

  it('constructs a connector when token AND projects are present (lazy — no network)', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-gitlab-disk-'));
    await saveToken('gitlab', 'glpat-token', home);
    await saveGitLabConfig({ projects: ['acme/app'] }, home);
    const c = await createGitLabConnectorFromDisk({ home });
    expect(c).toBeDefined();
    expect(c!.source).toBe('gitlab');
  });
});
