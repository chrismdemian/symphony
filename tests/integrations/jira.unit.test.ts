import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JiraConnector,
  jiraPriorityToSymphony,
  createJiraConnectorFromDisk,
} from '../../src/integrations/jira.js';
import {
  defaultJiraConfig,
  loadJiraConfig,
  saveJiraConfig,
  JiraConfigError,
  type JiraConfig,
} from '../../src/integrations/jira-config.js';
import {
  JiraApiError,
  type JiraClientLike,
  type JiraIssueNode,
  type JiraTransition,
} from '../../src/integrations/jira-client.js';
import { saveToken } from '../../src/integrations/secrets.js';

function node(over: Partial<JiraIssueNode>): JiraIssueNode {
  return {
    key: 'ENG-1',
    summary: 'Fix the bug',
    description: 'details',
    webUrl: 'https://acme.atlassian.net/browse/ENG-1',
    statusName: 'To Do',
    statusCategoryKey: 'new',
    priorityName: 'Medium',
    labels: [],
    assignee: null,
    projectKey: 'ENG',
    updatedAt: '2026-06-01T00:00:00Z',
    ...over,
  };
}

interface FakeClient extends JiraClientLike {
  readonly searchCalls: { jql: string; limit: number }[];
  readonly commentCalls: { key: string; text: string }[];
  readonly transitionCalls: { key: string; transitionId: string }[];
}

function fakeClient(opts: {
  /** Map a JQL string → issues. The connector tries candidates in order; the
   *  first that resolves a non-empty array wins. A key that maps to an Error
   *  rejects (forbidden / unbrowsable). */
  byJql?: (jql: string) => JiraIssueNode[] | Error;
  recentKeys?: string[];
  issueByKey?: Record<string, JiraIssueNode | null>;
  transitions?: JiraTransition[];
  myself?: { displayName: string } | null;
  commentError?: Error;
  transitionError?: Error;
}): FakeClient {
  const searchCalls: FakeClient['searchCalls'] = [];
  const commentCalls: FakeClient['commentCalls'] = [];
  const transitionCalls: FakeClient['transitionCalls'] = [];
  return {
    searchCalls,
    commentCalls,
    transitionCalls,
    searchByJql: async (jql, limit) => {
      searchCalls.push({ jql, limit });
      const r = opts.byJql?.(jql) ?? [];
      if (r instanceof Error) throw r;
      return r;
    },
    getRecentIssueKeys: async () => opts.recentKeys ?? [],
    getIssue: async (key) => opts.issueByKey?.[key] ?? null,
    getTransitions: async () => opts.transitions ?? [],
    transitionIssue: async (key, transitionId) => {
      if (opts.transitionError) throw opts.transitionError;
      transitionCalls.push({ key, transitionId });
    },
    addComment: async (key, text) => {
      if (opts.commentError) throw opts.commentError;
      commentCalls.push({ key, text });
    },
    getMyself: async () => opts.myself ?? { displayName: 'jira-user' },
  };
}

function connector(client: JiraClientLike, config?: JiraConfig): JiraConnector {
  return new JiraConnector({
    client,
    config: config ?? { ...defaultJiraConfig(), siteUrl: 'https://acme.atlassian.net', email: 'me@acme.io' },
    sleep: () => Promise.resolve(),
  });
}

describe('jiraPriorityToSymphony', () => {
  it('maps the standard scheme to 0-3 (higher = sooner)', () => {
    expect(jiraPriorityToSymphony(null)).toBe(0);
    expect(jiraPriorityToSymphony('Highest')).toBe(3);
    expect(jiraPriorityToSymphony('High')).toBe(2);
    expect(jiraPriorityToSymphony('Medium')).toBe(1);
    expect(jiraPriorityToSymphony('Low')).toBe(0);
    expect(jiraPriorityToSymphony('Lowest')).toBe(0);
    expect(jiraPriorityToSymphony('Critical')).toBe(3);
    expect(jiraPriorityToSymphony('whatever')).toBe(0);
  });
});

describe('JiraConnector.fetchOpenIssues — JQL fallback chain', () => {
  it('leads with the configured-projects JQL when project keys are set', async () => {
    const config = {
      ...defaultJiraConfig(),
      siteUrl: 'https://acme.atlassian.net',
      email: 'me@acme.io',
      projectKeys: ['ENG', 'OPS'],
    };
    const client = fakeClient({
      byJql: (jql) => (jql.startsWith('project IN (ENG, OPS)') ? [node({ key: 'ENG-7' })] : []),
    });
    const issues = await connector(client, config).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['ENG-7']);
    // First candidate is the project-scoped one.
    expect(client.searchCalls[0]!.jql).toContain('project IN (ENG, OPS)');
    expect(client.searchCalls[0]!.jql).toContain('statusCategory != Done');
  });

  it('falls through to assignee when the first candidate errors (403)', async () => {
    const config = {
      ...defaultJiraConfig(),
      siteUrl: 'https://acme.atlassian.net',
      email: 'me@acme.io',
      projectKeys: ['ENG'],
    };
    const client = fakeClient({
      byJql: (jql) => {
        if (jql.startsWith('project IN')) return new JiraApiError('forbidden', 403);
        if (jql.startsWith('assignee')) return [node({ key: 'ENG-9' })];
        return [];
      },
    });
    const issues = await connector(client, config).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['ENG-9']);
  });

  it('uses the issue-picker fallback when every JQL candidate is empty', async () => {
    const client = fakeClient({
      byJql: () => [],
      recentKeys: ['ENG-3'],
      issueByKey: { 'ENG-3': node({ key: 'ENG-3' }) },
    });
    const issues = await connector(client).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['ENG-3']);
  });

  it('returns [] when JQL is empty AND the picker yields nothing', async () => {
    const client = fakeClient({ byJql: () => [], recentKeys: [] });
    expect(await connector(client).fetchOpenIssues()).toEqual([]);
  });

  it('maps statusCategory done → isTerminal (picker path can surface done issues)', async () => {
    const client = fakeClient({
      byJql: () => [],
      recentKeys: ['ENG-5'],
      issueByKey: { 'ENG-5': node({ key: 'ENG-5', statusCategoryKey: 'done', statusName: 'Done' }) },
    });
    const [a] = await connector(client).fetchOpenIssues();
    expect(a!.isTerminal).toBe(true);
  });

  it('maps a node to a NormalizedIssue with key id + project routing + priority', async () => {
    const client = fakeClient({
      byJql: (jql) => (jql.startsWith('assignee') ? [node({ key: 'ENG-2', priorityName: 'High', assignee: 'Dana' })] : []),
    });
    const [a] = await connector(client).fetchOpenIssues();
    expect(a).toMatchObject({
      externalId: 'ENG-2',
      title: 'Fix the bug',
      isTerminal: false,
      priority: 2,
      projectValue: 'ENG',
      assignee: 'Dana',
      url: 'https://acme.atlassian.net/browse/ENG-1',
    });
  });
});

describe('JiraConnector.writeBackStatus', () => {
  it('completed → comments then transitions to the first Done-category transition', async () => {
    const client = fakeClient({
      transitions: [
        { id: '11', name: 'In Progress', toStatusCategoryKey: 'indeterminate' },
        { id: '31', name: 'Done', toStatusCategoryKey: 'done' },
      ],
    });
    const r = await connector(client).writeBackStatus('ENG-1', 'completed');
    expect(r).toMatchObject({ written: true, code: 'written' });
    expect(r.value).toContain("'Done'");
    expect(client.commentCalls).toEqual([{ key: 'ENG-1', text: 'Completed by Symphony.' }]);
    expect(client.transitionCalls).toEqual([{ key: 'ENG-1', transitionId: '31' }]);
  });

  it('completed → honors a configured transition-name override', async () => {
    const config = {
      ...defaultJiraConfig(),
      siteUrl: 'https://acme.atlassian.net',
      email: 'me@acme.io',
      statusWriteback: { completedTransition: 'Resolve' },
    };
    const client = fakeClient({
      transitions: [
        { id: '41', name: 'Resolve', toStatusCategoryKey: 'done' },
        { id: '31', name: 'Done', toStatusCategoryKey: 'done' },
      ],
    });
    await connector(client, config).writeBackStatus('ENG-1', 'completed');
    expect(client.transitionCalls).toEqual([{ key: 'ENG-1', transitionId: '41' }]);
  });

  it('completed → commented but not-found (written:false, reason surfaced) when no Done transition exists', async () => {
    const client = fakeClient({
      transitions: [{ id: '11', name: 'In Progress', toStatusCategoryKey: 'indeterminate' }],
    });
    const r = await connector(client).writeBackStatus('ENG-1', 'completed');
    // written:false so the writeback hook logs the reason instead of a silent
    // success (the comment landed, but the move-to-Done couldn't be resolved).
    expect(r).toMatchObject({ written: false, code: 'not-found' });
    expect(r.reason).toContain('no Done transition');
    expect(client.commentCalls).toHaveLength(1); // comment still posted
    expect(client.transitionCalls).toHaveLength(0);
  });

  it('failed → skipped when no failed writeback is configured (never transitions)', async () => {
    const client = fakeClient({});
    const r = await connector(client).writeBackStatus('ENG-1', 'failed');
    expect(r).toMatchObject({ written: false, code: 'skipped' });
    expect(client.commentCalls).toEqual([]);
    expect(client.transitionCalls).toEqual([]);
  });

  it('failed → comments but never transitions when configured', async () => {
    const config = {
      ...defaultJiraConfig(),
      siteUrl: 'https://acme.atlassian.net',
      email: 'me@acme.io',
      statusWriteback: { failed: 'Could not finish.' },
    };
    const client = fakeClient({});
    const r = await connector(client, config).writeBackStatus('ENG-1', 'failed');
    expect(r).toMatchObject({ written: true, value: 'commented (no transition)' });
    expect(client.transitionCalls).toEqual([]);
  });

  it('not-found for an empty key', async () => {
    const r = await connector(fakeClient({})).writeBackStatus('   ', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('not-found when the comment API returns 404', async () => {
    const client = fakeClient({ commentError: new JiraApiError('gone', 404) });
    const r = await connector(client).writeBackStatus('ENG-1', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('error when the transition API fails (non-404)', async () => {
    const client = fakeClient({
      transitions: [{ id: '31', name: 'Done', toStatusCategoryKey: 'done' }],
      transitionError: new JiraApiError('server error', 500),
    });
    const r = await connector(client).writeBackStatus('ENG-1', 'completed');
    expect(r).toMatchObject({ written: false, code: 'error' });
  });
});

describe('JiraConnector.checkConnection', () => {
  it('ok with the display name', async () => {
    const r = await connector(fakeClient({ myself: { displayName: 'Chris' } })).checkConnection();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('Chris');
  });

  it('fails gracefully when the client throws', async () => {
    const client = fakeClient({});
    client.getMyself = async () => {
      throw new JiraApiError('Jira auth failed (401)', 401);
    };
    const r = await connector(client).checkConnection();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
  });
});

describe('jira-config', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('round-trips through disk and UNIONS project keys across patches', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-jira-cfg-'));
    expect(await loadJiraConfig(home)).toBeUndefined();
    await saveJiraConfig({ siteUrl: 'https://acme.atlassian.net', email: 'me@acme.io', projectKeys: ['ENG'] }, home);
    const merged = await saveJiraConfig({ projectKeys: ['OPS'] }, home);
    expect(merged.projectKeys).toEqual(['ENG', 'OPS']);
    expect(merged.siteUrl).toBe('https://acme.atlassian.net');
  });

  it('rejects a non-https siteUrl', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-jira-cfg-'));
    await expect(saveJiraConfig({ siteUrl: 'http://evil.example.com' }, home)).rejects.toBeTruthy();
  });

  it('rejects a malformed email', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-jira-cfg-'));
    await expect(saveJiraConfig({ email: 'not-an-email' }, home)).rejects.toBeTruthy();
  });

  it('throws JiraConfigError on malformed JSON', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-jira-cfg-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { integrationsDir } = await import('../../src/integrations/secrets.js');
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'jira.json'), '{ not json', 'utf8');
    await expect(loadJiraConfig(home)).rejects.toBeInstanceOf(JiraConfigError);
  });
});

describe('createJiraConnectorFromDisk', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('returns undefined when no token is stored', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-jira-disk-'));
    await saveJiraConfig({ siteUrl: 'https://acme.atlassian.net', email: 'me@acme.io' }, home);
    expect(await createJiraConnectorFromDisk({ home })).toBeUndefined();
  });

  it('returns undefined when a token is stored but no siteUrl/email', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-jira-disk-'));
    await saveToken('jira', 'tok', home);
    expect(await createJiraConnectorFromDisk({ home })).toBeUndefined();
  });

  it('constructs a connector when token + siteUrl + email are present (lazy — no network)', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-jira-disk-'));
    await saveToken('jira', 'tok', home);
    await saveJiraConfig({ siteUrl: 'https://acme.atlassian.net', email: 'me@acme.io' }, home);
    const c = await createJiraConnectorFromDisk({ home });
    expect(c).toBeDefined();
    expect(c!.source).toBe('jira');
  });
});
