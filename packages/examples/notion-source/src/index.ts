import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

import {
  NotionSource,
  NotionSourceConfigSchema,
  type NotionSourceConfig,
} from './notion.js';

/**
 * notion-source — the Symphony ISSUE-SOURCE plugin for Notion.
 *
 * Exposes the two tools the host's `PluginIssueConnectorAdapter` calls:
 *   - `fetch_open_issues({ limit? })` → `{ issues: NormalizedIssue[] }`
 *   - `write_back_status({ externalId, status })` → `IssueWritebackResult`
 * plus `check_connection`. The host wraps these into the SAME ingest +
 * writeback pipeline the in-tree Notion connector uses (`sync_notion`,
 * `task_external_links`, terminal-status writeback) — the plugin owns ONLY
 * the Notion I/O + its own config.
 *
 * The token + database id come from `<install-dir>/config.json` (Symphony's
 * env allowlist strips every `SYMPHONY_*` var — a plugin sources its own
 * secrets, never Symphony's keychain). stdout is the MCP channel; all
 * diagnostics go to stderr.
 *
 * Notion is PULL-only (no `pollIntervalMs` in the manifest): Maestro drives
 * `sync_notion` on demand. Symphony owns task status after creation and pushes
 * terminal statuses back to the page property automatically.
 */

class ConfigError extends Error {}

/**
 * One long-lived `NotionSource` for the process — built lazily on first use.
 * This is load-bearing, not an optimization: the connector's serialized
 * request throttle and `resolveSchema` memoization only work ACROSS calls if
 * the instance survives. A fresh instance per tool call (the obvious shape)
 * would let a burst of simultaneous task-completion writebacks fire N
 * unserialized, schema-re-resolving requests at Notion → 429s (the 8A audit-M1
 * footgun). The in-tree connector is a boot-time singleton for the same reason;
 * config is read once, like at server boot (a config change needs a restart).
 */
let cachedSource: NotionSource | undefined;
function getSource(): NotionSource {
  cachedSource ??= new NotionSource(loadConfig());
  return cachedSource;
}

function loadConfig(): NotionSourceConfig {
  const file = path.join(process.cwd(), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(
      `notion-source is not configured — create ${file} with ` +
        '{ "token": "...", "databaseId": "..." }',
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = NotionSourceConfigSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
    throw new ConfigError(`config.json invalid${where}: ${first?.message ?? 'bad config'}`);
  }
  return parsed.data;
}

await createPlugin({
  id: 'notion-source-example',
  name: 'Notion source (example)',
  version: '0.1.0',
})
  .tool({
    name: 'fetch_open_issues',
    description:
      'Return Notion pages from the configured database as NormalizedIssue[] (issue-source contract). Pages already in a terminal status are flagged isTerminal so the host skips them.',
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe('Max pages to return (default per config).'),
    },
    handler: async ({ limit }) => {
      const issues = await getSource().fetchOpenIssues(limit);
      return { text: `Fetched ${issues.length} Notion page(s).`, structuredContent: { issues } };
    },
  })
  .tool({
    name: 'write_back_status',
    description:
      'Push a terminal task status to a Notion page: completed → set the status property to the configured "completed" value; failed → set the "failed" value (only if configured).',
    inputSchema: {
      externalId: z.string().min(1).describe('Notion page id'),
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
    description: 'Verify the Notion token by fetching the integration bot user.',
    handler: async () => {
      let source: NotionSource;
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

process.stderr.write('[notion-source] serving — Notion issue source for Symphony\n');
