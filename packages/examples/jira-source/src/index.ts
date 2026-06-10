import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

import {
  JiraSource,
  JiraSourceConfigSchema,
  type JiraSourceConfig,
} from './jira.js';

/**
 * jira-source — the Symphony ISSUE-SOURCE plugin for Jira Cloud.
 *
 * Exposes the tools the host's `PluginIssueConnectorAdapter` calls:
 *   - `fetch_open_issues({ limit? })` → `{ issues: NormalizedIssue[] }`
 *   - `write_back_status({ externalId, status })` → `IssueWritebackResult`
 * plus `search_issues` + `check_connection`. The host wraps these into the SAME
 * ingest + writeback pipeline the in-tree Jira connector uses (`sync_jira`,
 * `task_external_links`, terminal-status writeback) — the plugin owns ONLY the
 * Jira I/O + its own config.
 *
 * The token + siteUrl + email come from `<install-dir>/config.json` (Symphony's
 * env allowlist strips every `SYMPHONY_*` var — a plugin sources its own
 * secrets, never Symphony's keychain). stdout is the MCP channel; diagnostics
 * go to stderr.
 *
 * Jira is PULL-only (no `pollIntervalMs` in the manifest): Maestro drives
 * `sync_jira` on demand. On completion Symphony comments + transitions the
 * issue to a Done-category state.
 */

class ConfigError extends Error {}

/**
 * One long-lived `JiraSource` for the process — built lazily on first use.
 * Load-bearing: the connector's serialized request throttle only works ACROSS
 * calls if the instance survives. Config is read once, like at boot.
 */
let cachedSource: JiraSource | undefined;
function getSource(): JiraSource {
  cachedSource ??= new JiraSource(loadConfig());
  return cachedSource;
}

function loadConfig(): JiraSourceConfig {
  const file = path.join(process.cwd(), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(
      `jira-source is not configured — create ${file} with ` +
        '{ "token": "...", "siteUrl": "https://acme.atlassian.net", "email": "you@acme.com" }',
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = JiraSourceConfigSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
    throw new ConfigError(`config.json invalid${where}: ${first?.message ?? 'bad config'}`);
  }
  return parsed.data;
}

await createPlugin({
  id: 'jira-source-example',
  name: 'Jira source (example)',
  version: '0.1.0',
})
  .tool({
    name: 'fetch_open_issues',
    description:
      'Return Jira issues as NormalizedIssue[] (issue-source contract) via a JQL fallback chain. Issues in a Done status category are flagged isTerminal so the host skips them.',
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe('Max issues to return (default per config).'),
    },
    handler: async ({ limit }) => {
      const issues = await getSource().fetchOpenIssues(limit);
      return { text: `Fetched ${issues.length} Jira issue(s).`, structuredContent: { issues } };
    },
  })
  .tool({
    name: 'search_issues',
    description: 'Text search for Jira issues (JQL `text ~ "..."`).',
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
      'Push a terminal task status to a Jira issue: completed → comment + transition to a Done-category state; failed → comment only (no transition), and only if configured.',
    inputSchema: {
      externalId: z.string().min(1).describe('Jira issue key (e.g. ENG-123)'),
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
    description: 'Verify the Jira credentials by fetching the authenticated user.',
    handler: async () => {
      let source: JiraSource;
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

process.stderr.write('[jira-source] serving — Jira issue source for Symphony\n');
