import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PlainConnector,
  plainPriorityToScore,
  createPlainConnectorFromDisk,
} from '../../src/integrations/plain.js';
import {
  defaultPlainConfig,
  loadPlainConfig,
  savePlainConfig,
  PlainConfigError,
  type PlainConfig,
} from '../../src/integrations/plain-config.js';
import type { PlainClientLike, PlainThreadNode } from '../../src/integrations/plain-client.js';
import { saveToken } from '../../src/integrations/secrets.js';

function node(over: Partial<PlainThreadNode>): PlainThreadNode {
  return {
    id: 't_1',
    ref: 'T-1',
    title: 'Fix the bug',
    previewText: 'details',
    status: 'TODO',
    priority: null,
    customerId: 'c_1',
    labels: [],
    updatedAt: '2026-06-01T00:00:00Z',
    url: 'https://app.plain.com/workspace/ws_1/thread/t_1',
    ...over,
  };
}

interface FakeClient extends PlainClientLike {
  readonly noteCalls: { threadId: string; customerId: string; body: string }[];
  readonly doneCalls: string[];
}

function fakeClient(opts: {
  threads?: PlainThreadNode[];
  search?: PlainThreadNode[];
  workspace?: { id: string; name: string } | null;
  customerByThread?: Record<string, string | null>;
  noteError?: Error;
  doneError?: Error;
  customerError?: Error;
}): FakeClient {
  const noteCalls: FakeClient['noteCalls'] = [];
  const doneCalls: FakeClient['doneCalls'] = [];
  return {
    noteCalls,
    doneCalls,
    listOpenThreads: async () => opts.threads ?? [],
    searchThreads: async () => opts.search ?? [],
    getThreadCustomerId: async (threadId) => {
      if (opts.customerError) throw opts.customerError;
      if (opts.customerByThread && threadId in opts.customerByThread) {
        return opts.customerByThread[threadId] ?? null;
      }
      return 'c_default';
    },
    addNote: async (threadId, customerId, body) => {
      if (opts.noteError) throw opts.noteError;
      noteCalls.push({ threadId, customerId, body });
    },
    markThreadDone: async (threadId) => {
      if (opts.doneError) throw opts.doneError;
      doneCalls.push(threadId);
    },
    getWorkspace: async () => opts.workspace ?? { id: 'ws_1', name: 'Acme Support' },
  };
}

function connector(client: PlainClientLike, config?: PlainConfig): PlainConnector {
  return new PlainConnector({
    client,
    config: config ?? defaultPlainConfig(),
    sleep: () => Promise.resolve(),
  });
}

describe('plainPriorityToScore', () => {
  it('inverts Plain priority (0=urgent → 3 … 3=low → 0); null/oob → 0', () => {
    expect(plainPriorityToScore(0)).toBe(3);
    expect(plainPriorityToScore(1)).toBe(2);
    expect(plainPriorityToScore(2)).toBe(1);
    expect(plainPriorityToScore(3)).toBe(0);
    expect(plainPriorityToScore(null)).toBe(0);
    expect(plainPriorityToScore(7)).toBe(0);
    expect(plainPriorityToScore(-1)).toBe(0);
  });
});

describe('PlainConnector.fetchOpenIssues', () => {
  it('maps a thread → NormalizedIssue (thread id, status, inverted priority, null routing)', async () => {
    const c = connector(
      fakeClient({
        threads: [
          node({ id: 't_42', title: 'Open one', status: 'TODO', priority: 0, labels: ['bug'] }),
        ],
      }),
    );
    const issues = await c.fetchOpenIssues();
    expect(issues).toHaveLength(1);
    const a = issues[0]!;
    expect(a.externalId).toBe('t_42');
    expect(a.title).toBe('Open one');
    expect(a.state).toBe('TODO');
    expect(a.isTerminal).toBe(false);
    expect(a.priority).toBe(3); // urgent (0) → 3
    expect(a.projectValue).toBeNull(); // Plain has no Symphony-project concept
    expect(a.body).toBe('details');
    expect(a.labels).toEqual(['bug']);
  });

  it('classifies DONE threads as terminal', async () => {
    const c = connector(fakeClient({ threads: [node({ status: 'DONE' })] }));
    const [a] = await c.fetchOpenIssues();
    expect(a!.isTerminal).toBe(true);
  });

  it('falls back to a placeholder title (using the ref) for blank titles', async () => {
    const c = connector(fakeClient({ threads: [node({ id: 't_9', ref: 'T-9', title: '  ' })] }));
    const [a] = await c.fetchOpenIssues();
    expect(a!.title).toBe('(untitled Plain thread T-9)');
  });

  it('passes search results through the same mapping', async () => {
    const c = connector(fakeClient({ search: [node({ id: 't_3', title: 'Searched' })] }));
    const issues = await c.searchIssues('whatever');
    expect(issues.map((i) => i.externalId)).toEqual(['t_3']);
  });
});

describe('PlainConnector.writeBackStatus', () => {
  it('completed → resolves customer, notes (default), then marks done', async () => {
    const client = fakeClient({});
    const r = await connector(client).writeBackStatus('t_1', 'completed');
    expect(r).toMatchObject({ written: true, code: 'written', value: 'noted + done' });
    expect(client.noteCalls).toEqual([{ threadId: 't_1', customerId: 'c_default', body: 'Completed by Symphony.' }]);
    expect(client.doneCalls).toEqual(['t_1']);
  });

  it('completed → honors a configured completion note', async () => {
    const config = { ...defaultPlainConfig(), statusWriteback: { completed: 'Resolved!' } };
    const client = fakeClient({});
    await connector(client, config).writeBackStatus('t_1', 'completed');
    expect(client.noteCalls[0]!.body).toBe('Resolved!');
    expect(client.doneCalls).toEqual(['t_1']);
  });

  it('completed → not-found when the thread (customer) cannot be resolved', async () => {
    const client = fakeClient({ customerByThread: { t_gone: null } });
    const r = await connector(client).writeBackStatus('t_gone', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
    expect(client.doneCalls).toEqual([]);
  });

  it('failed → skipped when no failed writeback is configured', async () => {
    const client = fakeClient({});
    const r = await connector(client).writeBackStatus('t_1', 'failed');
    expect(r).toMatchObject({ written: false, code: 'skipped' });
    expect(client.noteCalls).toEqual([]);
    expect(client.doneCalls).toEqual([]);
  });

  it('failed → notes but never marks done when configured', async () => {
    const config = { ...defaultPlainConfig(), statusWriteback: { failed: 'Could not finish.' } };
    const client = fakeClient({});
    const r = await connector(client, config).writeBackStatus('t_1', 'failed');
    expect(r).toMatchObject({ written: true, value: 'noted (left open)' });
    expect(client.noteCalls[0]!.body).toBe('Could not finish.');
    expect(client.doneCalls).toEqual([]);
  });

  it('failed → not-found when configured but the thread cannot be resolved', async () => {
    const config = { ...defaultPlainConfig(), statusWriteback: { failed: 'oops' } };
    const client = fakeClient({ customerByThread: { t_gone: null } });
    const r = await connector(client, config).writeBackStatus('t_gone', 'failed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('not-found for a blank external id', async () => {
    const r = await connector(fakeClient({})).writeBackStatus('   ', 'completed');
    expect(r).toMatchObject({ written: false, code: 'not-found' });
  });

  it('error when the note call throws', async () => {
    const client = fakeClient({ noteError: new Error('boom') });
    const r = await connector(client).writeBackStatus('t_1', 'completed');
    expect(r).toMatchObject({ written: false, code: 'error' });
  });

  it('error when marking done throws', async () => {
    const client = fakeClient({ doneError: new Error('boom') });
    const r = await connector(client).writeBackStatus('t_1', 'completed');
    expect(r).toMatchObject({ written: false, code: 'error' });
  });
});

describe('PlainConnector.checkConnection', () => {
  it('ok with the workspace name', async () => {
    const r = await connector(fakeClient({ workspace: { id: 'ws_1', name: 'Acme Support' } })).checkConnection();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('Acme Support');
  });

  it('fails gracefully when the client throws', async () => {
    const client = fakeClient({});
    client.getWorkspace = async () => {
      throw new Error('Plain auth failed (401)');
    };
    const r = await connector(client).checkConnection();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('401');
  });
});

describe('plain-config', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('round-trips through disk; statuses REPLACE (not union)', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-plain-cfg-'));
    expect(await loadPlainConfig(home)).toBeUndefined();
    await savePlainConfig({ statuses: ['TODO', 'SNOOZED'] }, home);
    const merged = await savePlainConfig({ statuses: ['TODO'], statusWriteback: { failed: 'oops' } }, home);
    expect(merged.statuses).toEqual(['TODO']);
    expect(merged.statusWriteback.failed).toBe('oops');
  });

  it('defaults statuses to ["TODO"]', () => {
    expect(defaultPlainConfig().statuses).toEqual(['TODO']);
  });

  it('rejects an unknown thread status', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-plain-cfg-'));
    await expect(
      savePlainConfig({ statuses: ['NOPE'] as unknown as PlainConfig['statuses'] }, home),
    ).rejects.toBeTruthy();
  });

  it('rejects a non-https apiUrl but allows localhost http', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-plain-cfg-'));
    await expect(savePlainConfig({ apiUrl: 'http://evil.example.com' }, home)).rejects.toBeTruthy();
    const ok = await savePlainConfig({ apiUrl: 'https://core-api.eu.plain.com/graphql/v1' }, home);
    expect(ok.apiUrl).toBe('https://core-api.eu.plain.com/graphql/v1');
  });

  it('throws PlainConfigError on malformed JSON', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-plain-cfg-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { integrationsDir } = await import('../../src/integrations/secrets.js');
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(path.join(integrationsDir(home), 'plain.json'), '{ not json', 'utf8');
    await expect(loadPlainConfig(home)).rejects.toBeInstanceOf(PlainConfigError);
  });
});

describe('createPlainConnectorFromDisk', () => {
  let home: string;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('returns undefined when no token is stored', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-plain-disk-'));
    await savePlainConfig({ statuses: ['TODO'] }, home);
    expect(await createPlainConnectorFromDisk({ home })).toBeUndefined();
  });

  it('constructs a connector on a token alone (lazy — no network)', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-plain-disk-'));
    await saveToken('plain', 'plain-key', home);
    const c = await createPlainConnectorFromDisk({ home });
    expect(c).toBeDefined();
    expect(c!.source).toBe('plain');
  });
});
