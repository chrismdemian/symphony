import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

import {
  LinearSource,
  LinearSourceConfigSchema,
  type LinearSourceConfig,
} from './linear.js';

/**
 * linear-source — the Symphony ISSUE-SOURCE plugin for Linear.
 *
 * Exposes the tools the host's `PluginIssueConnectorAdapter` calls:
 *   - `fetch_open_issues({ limit? })` → `{ issues: NormalizedIssue[] }`
 *   - `write_back_status({ externalId, status })` → `IssueWritebackResult`
 * plus `search_issues` + `check_connection`. The host wraps these into the SAME
 * ingest + writeback pipeline the in-tree Linear connector uses (`sync_linear`,
 * `task_external_links`, terminal-status writeback) — the plugin owns ONLY the
 * Linear I/O + its own config.
 *
 * The API key comes from `<install-dir>/config.json` (Symphony's env allowlist
 * strips every `SYMPHONY_*` var — a plugin sources its own secrets, never
 * Symphony's keychain). stdout is the MCP channel; diagnostics go to stderr.
 *
 * Linear is PULL-only (no `pollIntervalMs` in the manifest): Maestro drives
 * `sync_linear` on demand. Symphony owns task status after creation and pushes
 * terminal statuses back to the issue's workflow state automatically.
 */

class ConfigError extends Error {}

/**
 * One long-lived `LinearSource` for the process — built lazily on first use.
 * Load-bearing, not an optimization: the connector's serialized request
 * throttle only works ACROSS calls if the instance survives. A fresh instance
 * per tool call would let a burst of simultaneous task-completion writebacks
 * fire unserialized requests at Linear. Config is read once, like at boot.
 */
let cachedSource: LinearSource | undefined;
function getSource(): LinearSource {
  cachedSource ??= new LinearSource(loadConfig());
  return cachedSource;
}

function loadConfig(): LinearSourceConfig {
  const file = path.join(process.cwd(), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(
      `linear-source is not configured — create ${file} with { "token": "..." }`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = LinearSourceConfigSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
    throw new ConfigError(`config.json invalid${where}: ${first?.message ?? 'bad config'}`);
  }
  return parsed.data;
}

await createPlugin({
  id: 'linear-source-example',
  name: 'Linear source (example)',
  version: '0.1.0',
})
  .tool({
    name: 'fetch_open_issues',
    description:
      'Return Linear issues as NormalizedIssue[] (issue-source contract). Issues in a terminal workflow state (completed/canceled) are flagged isTerminal so the host skips them.',
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe('Max issues to return (clamped to 250).'),
    },
    handler: async ({ limit }) => {
      const issues = await getSource().fetchOpenIssues(limit);
      return { text: `Fetched ${issues.length} Linear issue(s).`, structuredContent: { issues } };
    },
  })
  .tool({
    name: 'search_issues',
    description: 'Server-side full-text search for Linear issues.',
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
      "Push a terminal task status to a Linear issue: completed → move to the team's first completed-type workflow state (or the configured name); failed → move to a canceled-type state (only if a name is configured).",
    inputSchema: {
      externalId: z.string().min(1).describe('Linear issue id (UUID)'),
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
    description: 'Verify the Linear API key by fetching the authenticated user.',
    handler: async () => {
      let source: LinearSource;
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

process.stderr.write('[linear-source] serving — Linear issue source for Symphony\n');
