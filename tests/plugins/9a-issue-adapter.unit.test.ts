/**
 * Phase 9A — `PluginIssueConnectorAdapter` unit tests.
 *
 * The adapter wraps a plugin's `fetch_open_issues` / `write_back_status`
 * tools as an `IssueConnectorHandle`, calling a minimal tool-caller directly
 * and validating the plugin's UNTRUSTED `structuredContent`. These tests use
 * a fake caller (no subprocess) to cover the contract: shape mapping,
 * malformed-issue dropping, writeback-result parsing, and error paths.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ISSUE_SOURCE_INTERNAL_TOOLS,
  ISSUE_SOURCE_TOOL_NAMES,
  PluginIssueConnectorAdapter,
  type IssueSourceToolCaller,
} from '../../src/plugins/issue-connector-adapter.js';
import type { PluginCallResult } from '../../src/plugins/client.js';

function ok(structuredContent: Record<string, unknown>): PluginCallResult {
  return { content: [{ type: 'text', text: 'ok' }], structuredContent, isError: false };
}
function err(text: string): PluginCallResult {
  return { content: [{ type: 'text', text }], isError: true };
}

function validIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalId: 'acme/widgets#1',
    title: 'Fix the thing',
    url: 'https://github.com/acme/widgets/issues/1',
    state: 'open',
    isTerminal: false,
    body: 'b',
    assignee: 'octocat',
    labels: ['urgent'],
    projectValue: 'acme/widgets',
    priority: 3,
    updatedAt: '2026-06-01T00:00:00Z',
    ...over,
  };
}

function adapter(callTool: IssueSourceToolCaller['callTool'], log?: () => void): PluginIssueConnectorAdapter {
  return new PluginIssueConnectorAdapter({
    source: 'github',
    client: { callTool },
    ...(log !== undefined ? { log } : {}),
  });
}

describe('PluginIssueConnectorAdapter', () => {
  it('exposes its source + the internal-tool name set', () => {
    expect(ISSUE_SOURCE_TOOL_NAMES.fetchOpenIssues).toBe('fetch_open_issues');
    expect(ISSUE_SOURCE_TOOL_NAMES.writeBackStatus).toBe('write_back_status');
    expect([...ISSUE_SOURCE_INTERNAL_TOOLS].sort()).toEqual([
      'check_connection',
      'fetch_open_issues',
      'search_issues',
      'write_back_status',
    ]);
    expect(adapter(async () => ok({})).source).toBe('github');
  });

  it('calls fetch_open_issues directly and maps structuredContent → NormalizedIssue[]', async () => {
    const callTool = vi.fn(async () => ok({ issues: [validIssue()] }));
    const issues = await adapter(callTool).fetchOpenIssues({ limit: 5 });
    expect(callTool).toHaveBeenCalledWith('fetch_open_issues', { limit: 5 });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ externalId: 'acme/widgets#1', isTerminal: false, priority: 3 });
  });

  it('omits limit when not provided', async () => {
    const callTool = vi.fn(async () => ok({ issues: [] }));
    await adapter(callTool).fetchOpenIssues();
    expect(callTool).toHaveBeenCalledWith('fetch_open_issues', {});
  });

  it('drops malformed issues but keeps valid ones (one bad issue never aborts the batch)', async () => {
    const log = vi.fn();
    const callTool = async () =>
      ok({ issues: [validIssue(), { title: 'no id' }, validIssue({ externalId: 'acme/widgets#2', isTerminal: true }), 42] });
    const issues = await adapter(callTool, log).fetchOpenIssues();
    expect(issues.map((i) => i.externalId)).toEqual(['acme/widgets#1', 'acme/widgets#2']);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('malformed issue'));
  });

  it('fills defaults for optional fields and coerces bad scalars safely', async () => {
    const callTool = async () =>
      ok({ issues: [{ externalId: 'x#1', title: 't', isTerminal: false, labels: 'not-an-array', priority: 'high' }] });
    const [issue] = await adapter(callTool).fetchOpenIssues();
    expect(issue).toMatchObject({ url: null, labels: [], priority: 0, projectValue: null, assignee: null });
  });

  it('returns [] for a malformed fetch envelope', async () => {
    const log = vi.fn();
    const issues = await adapter(async () => ok({ nope: true }), log).fetchOpenIssues();
    expect(issues).toEqual([]);
  });

  it('throws on a fetch isError result (so sync_<source> surfaces it)', async () => {
    await expect(adapter(async () => err('GitHub 401 unauthorized')).fetchOpenIssues()).rejects.toThrow(/401/);
  });

  it('writeBackStatus calls write_back_status and parses the result', async () => {
    const callTool = vi.fn(async () => ok({ written: true, code: 'written', value: 'commented + closed' }));
    const res = await adapter(callTool).writeBackStatus('acme/widgets#1', 'completed');
    expect(callTool).toHaveBeenCalledWith('write_back_status', { externalId: 'acme/widgets#1', status: 'completed' });
    expect(res).toEqual({ written: true, code: 'written', value: 'commented + closed' });
  });

  it('maps a writeback isError result to code:error (observable, never throws)', async () => {
    const res = await adapter(async () => err('boom')).writeBackStatus('a#1', 'failed');
    expect(res).toEqual({ written: false, code: 'error', reason: 'boom' });
  });

  it('maps a malformed writeback structuredContent to code:error', async () => {
    const res = await adapter(async () => ok({ written: 'yes' })).writeBackStatus('a#1', 'completed');
    expect(res.code).toBe('error');
    expect(res.written).toBe(false);
  });

  it('maps a thrown caller to code:error on writeback', async () => {
    const res = await adapter(async () => {
      throw new Error('pipe closed');
    }).writeBackStatus('a#1', 'completed');
    expect(res).toEqual({ written: false, code: 'error', reason: 'pipe closed' });
  });

  it('checkConnection parses ok/detail and tolerates errors', async () => {
    expect(await adapter(async () => ok({ ok: true, detail: 'as octocat' })).checkConnection()).toEqual({
      ok: true,
      detail: 'as octocat',
    });
    expect((await adapter(async () => err('nope')).checkConnection()).ok).toBe(false);
    expect(
      (
        await adapter(async () => {
          throw new Error('x');
        }).checkConnection()
      ).ok,
    ).toBe(false);
  });

  it('carries an inert pollIntervalMs (9B seam)', () => {
    const a = new PluginIssueConnectorAdapter({ source: 'github', client: { callTool: async () => ok({}) }, pollIntervalMs: 5000 });
    expect(a.pollIntervalMs).toBe(5000);
  });
});
