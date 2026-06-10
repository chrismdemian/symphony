import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

import {
  SentrySource,
  SentrySourceConfigSchema,
  type SentrySourceConfig,
} from './sentry.js';

/**
 * sentry-source — the Symphony ISSUE-SOURCE plugin for Sentry.
 *
 * Exposes the tools the host's `PluginIssueConnectorAdapter` calls:
 *   - `fetch_open_issues({ limit? })` → `{ issues: NormalizedIssue[] }`
 *   - `write_back_status({ externalId, status })` → `IssueWritebackResult`
 * plus `search_issues` + `check_connection`. The host wraps these into the SAME
 * ingest + writeback pipeline the in-tree Sentry connector uses (`sync_sentry`,
 * `task_external_links`, terminal-status writeback) — the plugin owns ONLY the
 * Sentry I/O + its own config.
 *
 * The auth token (NOT a DSN) + org + projects come from `<install-dir>/config.json`
 * (Symphony's env allowlist strips every `SYMPHONY_*` var — a plugin sources its
 * own secrets, never Symphony's keychain). stdout is the MCP channel;
 * diagnostics go to stderr.
 *
 * Sentry is PULL-only (no `pollIntervalMs` in the manifest): Maestro drives
 * `sync_sentry` on demand. On completion Symphony posts an internal note and
 * resolves the issue ONLY when `resolveOnCompleted` is set (investigating ≠ fixing).
 */

class ConfigError extends Error {}

/**
 * One long-lived `SentrySource` for the process — built lazily on first use.
 * Load-bearing: the connector's serialized request throttle only works ACROSS
 * calls if the instance survives. Config is read once.
 */
let cachedSource: SentrySource | undefined;
function getSource(): SentrySource {
  cachedSource ??= new SentrySource(loadConfig());
  return cachedSource;
}

function loadConfig(): SentrySourceConfig {
  const file = path.join(process.cwd(), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(
      `sentry-source is not configured — create ${file} with ` +
        '{ "token": "...", "org": "my-org", "projects": ["my-project"] }',
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = SentrySourceConfigSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
    throw new ConfigError(`config.json invalid${where}: ${first?.message ?? 'bad config'}`);
  }
  return parsed.data;
}

await createPlugin({
  id: 'sentry-source-example',
  name: 'Sentry source (example)',
  version: '0.1.0',
})
  .tool({
    name: 'fetch_open_issues',
    description:
      'Return unresolved Sentry issues across the configured projects as NormalizedIssue[] (issue-source contract). Resolved/ignored/muted issues are flagged isTerminal so the host skips them. The error level rides as a single label.',
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe('Max issues per project (default per config).'),
    },
    handler: async ({ limit }) => {
      const issues = await getSource().fetchOpenIssues(limit);
      return { text: `Fetched ${issues.length} Sentry issue(s).`, structuredContent: { issues } };
    },
  })
  .tool({
    name: 'search_issues',
    description: 'Server-side search for unresolved Sentry issues across the configured projects (query=is:unresolved <term>).',
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
      'Push a terminal task status to a Sentry issue: completed → post an internal note (and resolve the issue ONLY when resolveOnCompleted is configured); failed → post a note only (never resolves), and only if configured.',
    inputSchema: {
      externalId: z.string().min(1).describe('Sentry issue id (<project>#<numericGroupId>)'),
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
    description: 'Verify the Sentry token by listing one issue from the first configured project.',
    handler: async () => {
      let source: SentrySource;
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

process.stderr.write('[sentry-source] serving — Sentry issue source for Symphony\n');
