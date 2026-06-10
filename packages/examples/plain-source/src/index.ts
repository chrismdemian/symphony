import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

import {
  PlainSource,
  PlainSourceConfigSchema,
  type PlainSourceConfig,
} from './plain.js';

/**
 * plain-source — the Symphony ISSUE-SOURCE plugin for Plain (customer support).
 *
 * Exposes the tools the host's `PluginIssueConnectorAdapter` calls:
 *   - `fetch_open_issues({ limit? })` → `{ issues: NormalizedIssue[] }`
 *   - `write_back_status({ externalId, status })` → `IssueWritebackResult`
 * plus `search_issues` + `check_connection`. The host wraps these into the SAME
 * ingest + writeback pipeline the in-tree Plain connector uses (`sync_plain`,
 * `task_external_links`, terminal-status writeback) — the plugin owns ONLY the
 * Plain I/O + its own config.
 *
 * The API key comes from `<install-dir>/config.json` (Symphony's env allowlist
 * strips every `SYMPHONY_*` var — a plugin sources its own secrets, never
 * Symphony's keychain). stdout is the MCP channel; diagnostics go to stderr.
 *
 * Plain is PULL-only (no `pollIntervalMs` in the manifest): Maestro drives
 * `sync_plain` on demand. On completion Symphony posts an INTERNAL note and marks
 * the thread done — NEVER a customer-facing reply.
 */

class ConfigError extends Error {}

/**
 * One long-lived `PlainSource` for the process — built lazily on first use.
 * Load-bearing: the connector's serialized request throttle + cached workspace
 * id only work ACROSS calls if the instance survives. Config is read once.
 */
let cachedSource: PlainSource | undefined;
function getSource(): PlainSource {
  cachedSource ??= new PlainSource(loadConfig());
  return cachedSource;
}

function loadConfig(): PlainSourceConfig {
  const file = path.join(process.cwd(), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(
      `plain-source is not configured — create ${file} with { "token": "..." }`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = PlainSourceConfigSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
    throw new ConfigError(`config.json invalid${where}: ${first?.message ?? 'bad config'}`);
  }
  return parsed.data;
}

await createPlugin({
  id: 'plain-source-example',
  name: 'Plain source (example)',
  version: '0.1.0',
})
  .tool({
    name: 'fetch_open_issues',
    description:
      'Return Plain threads in the configured statuses as NormalizedIssue[] (issue-source contract). DONE threads are flagged isTerminal so the host skips them.',
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe('Max threads to return (default per config).'),
    },
    handler: async ({ limit }) => {
      const issues = await getSource().fetchOpenIssues(limit);
      return { text: `Fetched ${issues.length} Plain thread(s).`, structuredContent: { issues } };
    },
  })
  .tool({
    name: 'search_issues',
    description: 'Client-side text search over the thread title, ref, and preview text (Plain has no server-side thread search).',
    inputSchema: {
      term: z.string().min(1),
      limit: z.number().int().min(1).max(500).optional(),
    },
    handler: async ({ term, limit }) => {
      const issues = await getSource().searchIssues(term, limit);
      return { text: `Found ${issues.length} thread(s).`, structuredContent: { issues } };
    },
  })
  .tool({
    name: 'write_back_status',
    description:
      'Push a terminal task status to a Plain thread: completed → post an INTERNAL note then mark the thread done; failed → post an internal note only (never marks done), and only if configured. NEVER sends a customer-facing reply.',
    inputSchema: {
      externalId: z.string().min(1).describe('Plain thread id'),
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
    description: 'Verify the Plain API key by fetching the authenticated workspace.',
    handler: async () => {
      let source: PlainSource;
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

process.stderr.write('[plain-source] serving — Plain issue source for Symphony\n');
