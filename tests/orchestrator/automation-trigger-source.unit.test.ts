import { describe, expect, it, vi } from 'vitest';
import {
  ISSUE_TRIGGER_FETCH_LIMIT,
  makeIssueTriggerSource,
} from '../../src/orchestrator/automation-trigger-source.js';
import type {
  IssueConnectorHandle,
  NormalizedIssue,
} from '../../src/integrations/issue-connector.js';

/**
 * Phase 8D.2 — the issue-connector → trigger-source adapter. Maps
 * NormalizedIssue → RawTriggerEvent, filters terminal issues, swallows fetch
 * errors to `[]`, and threads a stable `limit` for the ETag-cache benefit.
 */

function issue(over: Partial<NormalizedIssue>): NormalizedIssue {
  return {
    externalId: 'o/r#1',
    title: 'Bug',
    url: 'https://x/1',
    state: 'open',
    isTerminal: false,
    body: null,
    assignee: null,
    labels: [],
    projectValue: null,
    priority: 0,
    updatedAt: null,
    ...over,
  };
}

function fakeConnector(
  fetchOpenIssues: IssueConnectorHandle['fetchOpenIssues'],
  source = 'github',
): IssueConnectorHandle {
  return {
    source,
    fetchOpenIssues,
    writeBackStatus: async () => ({ written: false, code: 'skipped' }),
    checkConnection: async () => ({ ok: true }),
  };
}

describe('makeIssueTriggerSource', () => {
  it('maps issues to events with a source-namespaced id and carries filter fields', async () => {
    const connector = fakeConnector(async () => [
      issue({ externalId: 'o/r#42', title: 'Login broken', url: 'https://x/42', labels: ['bug'], assignee: 'alice' }),
    ]);
    const source = makeIssueTriggerSource({
      connector,
      triggerType: 'github_issue',
      displayType: 'GitHub issue',
    });
    expect(source.triggerType).toBe('github_issue');
    const events = await source.fetchEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: 'github:o/r#42',
      title: 'Login broken',
      url: 'https://x/42',
      type: 'GitHub issue',
      extra: 'o/r#42',
      labels: ['bug'],
      assignee: 'alice',
    });
  });

  it('filters out terminal (closed/done) issues', async () => {
    const connector = fakeConnector(async () => [
      issue({ externalId: 'o/r#1', isTerminal: false }),
      issue({ externalId: 'o/r#2', isTerminal: true }),
    ]);
    const source = makeIssueTriggerSource({ connector, triggerType: 'github_issue', displayType: 'GitHub issue' });
    const events = await source.fetchEvents();
    expect(events.map((e) => e.id)).toEqual(['github:o/r#1']);
  });

  it('swallows a fetch error and returns [] (one flaky source never aborts a cycle)', async () => {
    const log = vi.fn();
    const connector = fakeConnector(async () => {
      throw new Error('network down');
    });
    const source = makeIssueTriggerSource({
      connector,
      triggerType: 'linear_issue',
      displayType: 'Linear issue',
      log,
    });
    expect(await source.fetchEvents()).toEqual([]);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('network down'));
  });

  it('passes a stable limit ≤ 100 (ETag single-page cache benefit)', async () => {
    const fetchOpenIssues = vi.fn(async () => []);
    const source = makeIssueTriggerSource({
      connector: fakeConnector(fetchOpenIssues),
      triggerType: 'github_issue',
      displayType: 'GitHub issue',
    });
    await source.fetchEvents();
    await source.fetchEvents();
    expect(ISSUE_TRIGGER_FETCH_LIMIT).toBeLessThanOrEqual(100);
    expect(fetchOpenIssues).toHaveBeenNthCalledWith(1, { limit: ISSUE_TRIGGER_FETCH_LIMIT });
    expect(fetchOpenIssues).toHaveBeenNthCalledWith(2, { limit: ISSUE_TRIGGER_FETCH_LIMIT });
  });
});
