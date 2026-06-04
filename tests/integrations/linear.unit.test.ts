import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LinearConnector,
  linearPriorityToSymphony,
  createLinearConnectorFromDisk,
} from '../../src/integrations/linear.js';
import {
  defaultLinearConfig,
  loadLinearConfig,
  saveLinearConfig,
  LinearConfigError,
  type LinearConfig,
} from '../../src/integrations/linear-config.js';
import type {
  LinearClientLike,
  LinearIssueNode,
  LinearIssueWithStates,
  LinearWorkflowState,
} from '../../src/integrations/linear-client.js';
import { saveToken } from '../../src/integrations/secrets.js';

function node(over: Partial<LinearIssueNode>): LinearIssueNode {
  return {
    id: 'iss-1',
    identifier: 'ENG-1',
    title: 'Fix the bug',
    description: 'details',
    url: 'https://linear.app/team/issue/ENG-1',
    priority: 0,
    updatedAt: '2026-06-01T00:00:00Z',
    state: { name: 'Todo', type: 'unstarted' },
    team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
    project: null,
    assignee: null,
    ...over,
  };
}

interface FakeClient extends LinearClientLike {
  readonly updateCalls: { issueId: string; stateId: string }[];
}

function fakeClient(opts: {
  issues?: LinearIssueNode[];
  search?: LinearIssueNode[];
  issueWithStates?: LinearIssueWithStates | null;
  updateResult?: boolean;
  viewer?: { name: string } | null;
}): FakeClient {
  const updateCalls: { issueId: string; stateId: string }[] = [];
  return {
    updateCalls,
    listRecentIssues: async () => opts.issues ?? [],
    searchIssues: async () => opts.search ?? [],
    getIssueWithStates: async () => opts.issueWithStates ?? null,
    updateIssueState: async (issueId, stateId) => {
      updateCalls.push({ issueId, stateId });
      return opts.updateResult ?? true;
    },
    viewer: async () => opts.viewer ?? { name: 'Chris' },
  };
}

function connector(client: LinearClientLike, config: LinearConfig = defaultLinearConfig()): LinearConnector {
  // No real sleep — instant throttle for tests.
  return new LinearConnector({ client, config, sleep: () => Promise.resolve() });
}

function state(over: Partial<LinearWorkflowState>): LinearWorkflowState {
  return { id: 's-1', name: 'Backlog', type: 'backlog', position: 0, ...over };
}

describe('linearPriorityToSymphony', () => {
  it('inverts Linear priority (1 urgent → high int; 0 none → 0)', () => {
    expect(linearPriorityToSymphony(0)).toBe(0); // none
    expect(linearPriorityToSymphony(1)).toBe(3); // urgent
    expect(linearPriorityToSymphony(2)).toBe(2); // high
    expect(linearPriorityToSymphony(3)).toBe(1); // medium
    expect(linearPriorityToSymphony(4)).toBe(0); // low
    expect(linearPriorityToSymphony(99)).toBe(0); // out of range
  });
});

describe('LinearConnector.fetchOpenIssues', () => {
  it('maps nodes → NormalizedIssue (state, terminal, routing, priority)', async () => {
    const c = connector(
      fakeClient({
        issues: [
          node({
            id: 'a',
            title: 'Open one',
            priority: 1,
            state: { name: 'In Progress', type: 'started' },
            project: { name: 'Billing' },
            assignee: { displayName: 'Dana' },
          }),
          node({ id: 'b', title: 'Closed one', state: { name: 'Done', type: 'completed' } }),
          node({ id: 'c', title: 'Cancelled one', state: { name: 'Canceled', type: 'canceled' } }),
        ],
      }),
    );
    const issues = await c.fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['a', 'b', 'c']);
    const a = issues[0]!;
    expect(a.title).toBe('Open one');
    expect(a.state).toBe('In Progress');
    expect(a.isTerminal).toBe(false);
    expect(a.priority).toBe(3); // urgent → 3
    expect(a.projectValue).toBe('Billing'); // project name wins over team key
    expect(a.assignee).toBe('Dana');
    expect(a.url).toBe('https://linear.app/team/issue/ENG-1');
    // terminal classification
    expect(issues[1]!.isTerminal).toBe(true);
    expect(issues[2]!.isTerminal).toBe(true);
  });

  it('routes by team key when there is no project', async () => {
    const c = connector(fakeClient({ issues: [node({ id: 'a', project: null })] }));
    const [a] = await c.fetchOpenIssues();
    expect(a!.projectValue).toBe('ENG');
  });

  it('falls back to a placeholder title for blank titles', async () => {
    const c = connector(fakeClient({ issues: [node({ id: 'a', title: '   ', identifier: 'ENG-9' })] }));
    const [a] = await c.fetchOpenIssues();
    expect(a!.title).toBe('(untitled Linear issue ENG-9)');
  });

  it('clamps the requested limit to Linear\'s 250 first-page cap (audit Major)', async () => {
    let seenLimit: number | undefined;
    const client: LinearClientLike = {
      listRecentIssues: async (limit) => {
        seenLimit = limit;
        return [];
      },
      searchIssues: async () => [],
      getIssueWithStates: async () => null,
      updateIssueState: async () => false,
      viewer: async () => null,
    };
    await connector(client).fetchOpenIssues({ limit: 500 });
    expect(seenLimit).toBe(250);
  });
});

describe('LinearConnector.writeBackStatus', () => {
  const states: LinearWorkflowState[] = [
    state({ id: 'done-2', name: 'Released', type: 'completed', position: 2 }),
    state({ id: 'done-1', name: 'Done', type: 'completed', position: 1 }),
    state({ id: 'cancel-1', name: 'Canceled', type: 'canceled', position: 3 }),
  ];

  it('completed → auto-resolves the first completed-type state by position', async () => {
    const client = fakeClient({ issueWithStates: { id: 'iss-1', teamId: 'team-1', states } });
    const r = await connector(client).writeBackStatus('iss-1', 'completed');
    expect(r).toMatchObject({ written: true, code: 'written', value: 'Done' });
    expect(client.updateCalls).toEqual([{ issueId: 'iss-1', stateId: 'done-1' }]);
  });

  it('completed → honors a configured state name (case-insensitive)', async () => {
    const config = { ...defaultLinearConfig(), statusWriteback: { completed: 'released' } };
    const client = fakeClient({ issueWithStates: { id: 'iss-1', teamId: 'team-1', states } });
    const r = await connector(client, config).writeBackStatus('iss-1', 'completed');
    expect(r.value).toBe('Released');
    expect(client.updateCalls[0]!.stateId).toBe('done-2');
  });

  it('failed → skipped when no failed writeback is configured', async () => {
    const client = fakeClient({ issueWithStates: { id: 'iss-1', teamId: 'team-1', states } });
    const r = await connector(client).writeBackStatus('iss-1', 'failed');
    expect(r).toMatchObject({ written: false, code: 'skipped' });
    expect(client.updateCalls).toEqual([]);
  });

  it('failed → moves to a configured cancelled state when set', async () => {
    const config = { ...defaultLinearConfig(), statusWriteback: { failed: 'Canceled' } };
    const client = fakeClient({ issueWithStates: { id: 'iss-1', teamId: 'team-1', states } });
    const r = await connector(client, config).writeBackStatus('iss-1', 'failed');
    expect(r).toMatchObject({ written: true, value: 'Canceled' });
    expect(client.updateCalls[0]!.stateId).toBe('cancel-1');
  });

  it('not-found when the issue cannot be resolved', async () => {
    const r = await connector(fakeClient({ issueWithStates: null })).writeBackStatus('gone', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('not-found when the team has no completed-type state', async () => {
    const onlyBacklog: LinearIssueWithStates = {
      id: 'iss-1',
      teamId: 'team-1',
      states: [state({ id: 'b', name: 'Backlog', type: 'backlog', position: 0 })],
    };
    const r = await connector(fakeClient({ issueWithStates: onlyBacklog })).writeBackStatus('iss-1', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('error when the update returns success=false', async () => {
    const client = fakeClient({
      issueWithStates: { id: 'iss-1', teamId: 'team-1', states },
      updateResult: false,
    });
    const r = await connector(client).writeBackStatus('iss-1', 'completed');
    expect(r).toMatchObject({ written: false, code: 'error' });
  });
});

describe('LinearConnector.checkConnection', () => {
  it('ok with the viewer name', async () => {
    const r = await connector(fakeClient({ viewer: { name: 'Chris' } })).checkConnection();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('Chris');
  });

  it('fails gracefully when the client throws', async () => {
    const client: LinearClientLike = {
      listRecentIssues: async () => [],
      searchIssues: async () => [],
      getIssueWithStates: async () => null,
      updateIssueState: async () => false,
      viewer: async () => {
        throw new Error('Linear API 401');
      },
    };
    const r = await connector(client).checkConnection();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
  });
});

describe('linear-config', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('round-trips through disk and accumulates patches', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-linear-cfg-'));
    expect(await loadLinearConfig(home)).toBeUndefined();
    await saveLinearConfig({ teamKey: 'ENG' }, home);
    const merged = await saveLinearConfig({ statusWriteback: { failed: 'Canceled' } }, home);
    expect(merged.teamKey).toBe('ENG');
    expect(merged.statusWriteback.failed).toBe('Canceled');
    const reloaded = await loadLinearConfig(home);
    expect(reloaded?.teamKey).toBe('ENG');
  });

  it('throws LinearConfigError on malformed JSON', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-linear-cfg-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { integrationsDir } = await import('../../src/integrations/secrets.js');
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'linear.json'), '{ not json', 'utf8');
    await expect(loadLinearConfig(home)).rejects.toBeInstanceOf(LinearConfigError);
  });
});

describe('createLinearConnectorFromDisk', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('returns undefined when no API key is stored', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-linear-disk-'));
    expect(await createLinearConnectorFromDisk({ home })).toBeUndefined();
  });

  it('constructs a connector when a key is stored (lazy — no network)', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-linear-disk-'));
    await saveToken('linear', 'lin_api_key', home);
    const c = await createLinearConnectorFromDisk({ home });
    expect(c).toBeDefined();
    expect(c!.source).toBe('linear');
  });
});
