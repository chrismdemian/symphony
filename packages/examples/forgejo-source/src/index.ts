import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

import {
  ForgejoSource,
  ForgejoSourceConfigSchema,
  type ForgejoSourceConfig,
} from './forgejo.js';

/**
 * forgejo-source — the Symphony ISSUE-SOURCE plugin for Forgejo (Gitea-compatible).
 *
 * Exposes the tools the host's `PluginIssueConnectorAdapter` calls:
 *   - `fetch_open_issues({ limit? })` → `{ issues: NormalizedIssue[] }`
 *   - `write_back_status({ externalId, status })` → `IssueWritebackResult`
 * plus `search_issues` + `check_connection`. The host wraps these into the SAME
 * ingest + writeback pipeline the in-tree Forgejo connector uses (`sync_forgejo`,
 * `task_external_links`, terminal-status writeback) — the plugin owns ONLY the
 * Forgejo I/O + its own config.
 *
 * The token + siteUrl + repos come from `<install-dir>/config.json` (Symphony's
 * env allowlist strips every `SYMPHONY_*` var — a plugin sources its own
 * secrets, never Symphony's keychain). stdout is the MCP channel; diagnostics
 * go to stderr.
 *
 * Forgejo is PULL-only (no `pollIntervalMs` in the manifest): Maestro drives
 * `sync_forgejo` on demand. On completion Symphony comments + closes the issue.
 */

class ConfigError extends Error {}

/**
 * One long-lived `ForgejoSource` for the process — built lazily on first use.
 * Load-bearing: the connector's serialized request throttle + per-repo ETag
 * cache only work ACROSS calls if the instance survives. Config is read once.
 */
let cachedSource: ForgejoSource | undefined;
function getSource(): ForgejoSource {
  cachedSource ??= new ForgejoSource(loadConfig());
  return cachedSource;
}

function loadConfig(): ForgejoSourceConfig {
  const file = path.join(process.cwd(), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(
      `forgejo-source is not configured — create ${file} with ` +
        '{ "token": "...", "siteUrl": "https://code.acme.com", "repos": ["owner/repo"] }',
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ForgejoSourceConfigSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
    throw new ConfigError(`config.json invalid${where}: ${first?.message ?? 'bad config'}`);
  }
  return parsed.data;
}

await createPlugin({
  id: 'forgejo-source-example',
  name: 'Forgejo source (example)',
  version: '0.1.0',
})
  .tool({
    name: 'fetch_open_issues',
    description:
      'Return Forgejo issues across the configured repos as NormalizedIssue[] (issue-source contract). Pull requests are excluded; closed issues are flagged isTerminal so the host skips them.',
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe('Max issues to return (default per config).'),
    },
    handler: async ({ limit }) => {
      const issues = await getSource().fetchOpenIssues(limit);
      return { text: `Fetched ${issues.length} Forgejo issue(s).`, structuredContent: { issues } };
    },
  })
  .tool({
    name: 'search_issues',
    description: 'Server-side search for Forgejo issues (title + body) across the configured repos.',
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
      'Push a terminal task status to a Forgejo issue: completed → add a comment then close; failed → add a comment only (never close), and only if configured.',
    inputSchema: {
      externalId: z.string().min(1).describe('Forgejo issue id (owner/repo#number)'),
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
    description: 'Verify the Forgejo token by fetching the authenticated user.',
    handler: async () => {
      let source: ForgejoSource;
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

process.stderr.write('[forgejo-source] serving — Forgejo issue source for Symphony\n');
