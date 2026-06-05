import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  startOrchestratorServer,
  type OrchestratorServerHandle,
} from '../../src/orchestrator/index.js';
import { SymphonyDatabase } from '../../src/state/db.js';
import { SqliteExternalLinkStore } from '../../src/state/sqlite-external-link-store.js';
import { JiraConnector } from '../../src/integrations/jira.js';
import { defaultJiraConfig } from '../../src/integrations/jira-config.js';
import type {
  JiraClientLike,
  JiraIssueNode,
  JiraTransition,
} from '../../src/integrations/jira-client.js';
import { GitLabConnector } from '../../src/integrations/gitlab.js';
import { defaultGitLabConfig } from '../../src/integrations/gitlab-config.js';
import type { GitLabClientLike, GitLabIssueNode } from '../../src/integrations/gitlab-client.js';

// The scenarios config does not load tests/setup.ts — guard the keychain anyway
// (this test injects both connectors + fake clients and never reads tokens).
process.env.SYMPHONY_DISABLE_KEYRING = '1';

/**
 * Phase 8C.3 production scenario — see 8c3.md. Real server + temp-file SQLite +
 * REAL Jira AND GitLab connectors over injected fake clients, wired into ONE
 * server. Proves both connectors coexist: each sync routes + dedups + persists,
 * and each terminal task transition fires ONLY its own writeback (Jira: comment
 * + transition; GitLab: note + close by iid) with no cross-talk.
 */

function jiraNode(over: Partial<JiraIssueNode>): JiraIssueNode {
  return {
    key: 'ENG-1',
    summary: 'Issue',
    description: null,
    webUrl: 'https://acme.atlassian.net/browse/ENG-1',
    statusName: 'To Do',
    statusCategoryKey: 'new',
    priorityName: null,
    labels: [],
    assignee: null,
    projectKey: 'ENG',
    updatedAt: '2026-06-10T09:00:00Z',
    ...over,
  };
}

function gitlabNode(over: Partial<GitLabIssueNode>): GitLabIssueNode {
  return {
    projectPath: 'acme/app',
    id: 1000,
    iid: 1,
    title: 'Issue',
    body: null,
    state: 'opened',
    webUrl: 'https://gitlab.com/acme/app/-/issues/1',
    updatedAt: '2026-06-10T09:00:00Z',
    labels: [],
    assignee: null,
    ...over,
  };
}

interface FakeJira extends JiraClientLike {
  readonly commentCalls: { key: string; text: string }[];
  readonly transitionCalls: { key: string; transitionId: string }[];
}

function fakeJira(issues: JiraIssueNode[], transitions: JiraTransition[]): FakeJira {
  const commentCalls: FakeJira['commentCalls'] = [];
  const transitionCalls: FakeJira['transitionCalls'] = [];
  return {
    commentCalls,
    transitionCalls,
    searchByJql: async (jql) => (jql.startsWith('assignee') ? issues : []),
    getRecentIssueKeys: async () => [],
    getIssue: async () => null,
    getTransitions: async () => transitions,
    transitionIssue: async (key, transitionId) => {
      transitionCalls.push({ key, transitionId });
    },
    addComment: async (key, text) => {
      commentCalls.push({ key, text });
    },
    getMyself: async () => ({ displayName: 'chris' }),
  };
}

interface FakeGitLab extends GitLabClientLike {
  readonly noteCalls: { projectPath: string; iid: number; body: string }[];
  readonly closeCalls: { projectPath: string; iid: number }[];
}

function fakeGitLab(issuesByProject: Record<string, GitLabIssueNode[]>): FakeGitLab {
  const noteCalls: FakeGitLab['noteCalls'] = [];
  const closeCalls: FakeGitLab['closeCalls'] = [];
  return {
    noteCalls,
    closeCalls,
    listOpenIssues: async (projectPath) => issuesByProject[projectPath] ?? [],
    searchIssues: async () => [],
    addNote: async (projectPath, iid, body) => {
      noteCalls.push({ projectPath, iid, body });
    },
    closeIssue: async (projectPath, iid) => {
      closeCalls.push({ projectPath, iid });
    },
    getViewer: async () => ({ username: 'chris' }),
  };
}

interface Harness {
  client: Client;
  server: OrchestratorServerHandle;
  jira: FakeJira;
  gitlab: FakeGitLab;
  db: SymphonyDatabase;
  tmpRoot: string;
}

async function setup(): Promise<Harness> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), 'symphony-8c3-'));
  const db = SymphonyDatabase.open({ filePath: path.join(tmpRoot, 'symphony.db') });

  const jira = fakeJira(
    [
      jiraNode({ key: 'ENG-1', summary: 'Open jira', priorityName: 'High' }),
      jiraNode({ key: 'ENG-2', summary: 'Done jira', statusCategoryKey: 'done', statusName: 'Done' }),
    ],
    [
      { id: '11', name: 'In Progress', toStatusCategoryKey: 'indeterminate' },
      { id: '31', name: 'Done', toStatusCategoryKey: 'done' },
    ],
  );
  const jiraConnector = new JiraConnector({
    client: jira,
    config: { ...defaultJiraConfig(), siteUrl: 'https://acme.atlassian.net', email: 'me@acme.io' },
    sleep: () => Promise.resolve(),
  });

  const gitlab = fakeGitLab({
    'acme/app': [
      gitlabNode({ projectPath: 'acme/app', iid: 1, title: 'Open gitlab', labels: ['priority::high'] }),
      gitlabNode({ projectPath: 'acme/app', iid: 2, title: 'Closed gitlab', state: 'closed' }),
    ],
  });
  const gitlabConnector = new GitLabConnector({
    client: gitlab,
    config: { ...defaultGitLabConfig(), projects: ['acme/app'] },
    sleep: () => Promise.resolve(),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await startOrchestratorServer({
    transport: serverTransport,
    initialMode: 'act',
    initialTier: 2, // sync_* are secrets/network/external-visible → tier >= 2
    database: db,
    projects: {
      ENG: path.join(tmpRoot, 'eng'),
      'acme/app': path.join(tmpRoot, 'app'),
    },
    jiraConnector,
    gitlabConnector,
  });
  const client = new Client({ name: '8c3-scenario', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, server, jira, gitlab, db, tmpRoot };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await Promise.resolve();
}

describe('Phase 8C.3 — production scenario (real server, both connectors, temp-file SQLite)', () => {
  let h: Harness | null = null;

  beforeEach(async () => {
    h = await setup();
  });

  afterEach(async () => {
    if (!h) return;
    await h.client.close().catch(() => {});
    await h.server.close().catch(() => {});
    h.db.close();
    try {
      rmSync(h.tmpRoot, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* windows file-lock retry — best effort */
    }
    h = null;
  });

  it('syncs Jira + GitLab, skips done/closed, dedups, persists links, writes back independently', async () => {
    const cur = h!;

    // (1) Jira sync — creates ENG-1, skips the Done ENG-2
    const jres = await cur.client.callTool({ name: 'sync_jira', arguments: {} });
    expect(jres.isError).toBeFalsy();
    const jsc = jres.structuredContent as { createdCount: number; skippedDone: number };
    expect(jsc.createdCount).toBe(1);
    expect(jsc.skippedDone).toBe(1);

    // (2) GitLab sync — creates app#1, skips the closed app#2
    const gres = await cur.client.callTool({ name: 'sync_gitlab', arguments: {} });
    expect(gres.isError).toBeFalsy();
    const gsc = gres.structuredContent as { createdCount: number; skippedDone: number };
    expect(gsc.createdCount).toBe(1);
    expect(gsc.skippedDone).toBe(1);

    expect(cur.server.taskStore.size()).toBe(2);

    // (3) idempotent re-sync of both
    const jres2 = await cur.client.callTool({ name: 'sync_jira', arguments: {} });
    expect((jres2.structuredContent as { createdCount: number }).createdCount).toBe(0);
    const gres2 = await cur.client.callTool({ name: 'sync_gitlab', arguments: {} });
    expect((gres2.structuredContent as { createdCount: number }).createdCount).toBe(0);

    // (4) persistence across a fresh store over the SAME db file
    const fresh = new SqliteExternalLinkStore(cur.db.db);
    expect(fresh.listExternalIds('jira')).toEqual(new Set(['ENG-1']));
    expect(fresh.listExternalIds('gitlab')).toEqual(new Set(['acme/app#1']));

    // (5) completing the Jira task fires ONLY the Jira writeback
    const jiraTask = cur.server.taskStore.list().find((t) => t.description === 'Open jira')!;
    cur.server.taskStore.update(jiraTask.id, { status: 'in_progress' });
    cur.server.taskStore.update(jiraTask.id, { status: 'completed' });
    await flush();
    await new Promise((r) => setTimeout(r, 30));

    expect(cur.jira.commentCalls).toEqual([{ key: 'ENG-1', text: 'Completed by Symphony.' }]);
    expect(cur.jira.transitionCalls).toEqual([{ key: 'ENG-1', transitionId: '31' }]);
    expect(cur.gitlab.noteCalls).toEqual([]); // no cross-talk

    // (6) completing the GitLab task fires ONLY the GitLab writeback (note + close by iid)
    const gitlabTask = cur.server.taskStore.list().find((t) => t.description === 'Open gitlab')!;
    cur.server.taskStore.update(gitlabTask.id, { status: 'in_progress' });
    cur.server.taskStore.update(gitlabTask.id, { status: 'completed' });
    await flush();
    await new Promise((r) => setTimeout(r, 30));

    expect(cur.gitlab.noteCalls).toEqual([{ projectPath: 'acme/app', iid: 1, body: 'Completed by Symphony.' }]);
    expect(cur.gitlab.closeCalls).toEqual([{ projectPath: 'acme/app', iid: 1 }]);
    // Jira writeback did not fire a second time.
    expect(cur.jira.commentCalls).toHaveLength(1);
  });
});
