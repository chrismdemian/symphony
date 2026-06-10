import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

import {
  GitLabSource,
  GitLabSourceConfigSchema,
  type GitLabSourceConfig,
} from './gitlab.js';

/**
 * gitlab-source — the Symphony ISSUE-SOURCE plugin for GitLab.
 *
 * Exposes the tools the host's `PluginIssueConnectorAdapter` calls:
 *   - `fetch_open_issues({ limit? })` → `{ issues: NormalizedIssue[] }`
 *   - `write_back_status({ externalId, status })` → `IssueWritebackResult`
 * plus `search_issues` + `check_connection`. The host wraps these into the SAME
 * ingest + writeback pipeline the in-tree GitLab connector uses (`sync_gitlab`,
 * `task_external_links`, terminal-status writeback) — the plugin owns ONLY the
 * GitLab I/O + its own config.
 *
 * The token + projects (+ optional siteUrl) come from `<install-dir>/config.json`
 * (Symphony's env allowlist strips every `SYMPHONY_*` var — a plugin sources its
 * own secrets, never Symphony's keychain). stdout is the MCP channel;
 * diagnostics go to stderr.
 *
 * GitLab is PULL-only (no `pollIntervalMs` in the manifest): Maestro drives
 * `sync_gitlab` on demand. On completion Symphony notes + closes the issue.
 */

class ConfigError extends Error {}

/**
 * One long-lived `GitLabSource` for the process — built lazily on first use.
 * Load-bearing: the connector's serialized request throttle + per-project ETag
 * cache only work ACROSS calls if the instance survives. Config is read once.
 */
let cachedSource: GitLabSource | undefined;
function getSource(): GitLabSource {
  cachedSource ??= new GitLabSource(loadConfig());
  return cachedSource;
}

function loadConfig(): GitLabSourceConfig {
  const file = path.join(process.cwd(), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(
      `gitlab-source is not configured — create ${file} with ` +
        '{ "token": "...", "projects": ["group/project"] }',
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = GitLabSourceConfigSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
    throw new ConfigError(`config.json invalid${where}: ${first?.message ?? 'bad config'}`);
  }
  return parsed.data;
}

await createPlugin({
  id: 'gitlab-source-example',
  name: 'GitLab source (example)',
  version: '0.1.0',
})
  .tool({
    name: 'fetch_open_issues',
    description:
      'Return GitLab issues across the configured projects as NormalizedIssue[] (issue-source contract). Closed issues are flagged isTerminal so the host skips them.',
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe('Max issues to return (default per config).'),
    },
    handler: async ({ limit }) => {
      const issues = await getSource().fetchOpenIssues(limit);
      return { text: `Fetched ${issues.length} GitLab issue(s).`, structuredContent: { issues } };
    },
  })
  .tool({
    name: 'search_issues',
    description: 'Server-side search for GitLab issues (title + description) across the configured projects.',
    inputSchema: {
      term: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
    },
    handler: async ({ term, limit }) => {
      const issues = await getSource().searchIssues(term, limit);
      return { text: `Found ${issues.length} issue(s).`, structuredContent: { issues } };
    },
  })
  .tool({
    name: 'write_back_status',
    description:
      'Push a terminal task status to a GitLab issue: completed → add a note then close; failed → add a note only (never close), and only if configured.',
    inputSchema: {
      externalId: z.string().min(1).describe('GitLab issue id (group/project#iid)'),
      status: z.enum(['completed', 'failed']),
    },
    handler: async ({ externalId, status }) => {
      const result = await getSource().writeBack(externalId, status);
      return {
        text: result.written
          ? `${externalId}: → ${result.value}`
          : `${externalId}: ${result.code} (${result.reason ?? ''})`,
        structuredContent: { ...result },
      };
    },
  })
  .tool({
    name: 'check_connection',
    description: 'Verify the GitLab token by fetching the authenticated user.',
    handler: async () => {
      let source: GitLabSource;
      try {
        source = getSource();
      } catch (err) {
        return { structuredContent: { ok: false, detail: err instanceof Error ? err.message : String(err) } };
      }
      const result = await source.checkConnection();
      return { structuredContent: { ...result } };
    },
  })
  .serve();

process.stderr.write('[gitlab-source] serving — GitLab issue source for Symphony\n');
