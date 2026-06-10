import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createPlugin } from '@symphony/plugin-sdk';
import { z } from 'zod';

import { ObsidianSourceConfigSchema, type ObsidianSourceConfig } from './config.js';
import { ObsidianSource } from './obsidian.js';

/**
 * obsidian-source — the Symphony ISSUE-SOURCE plugin for an Obsidian vault.
 *
 * Exposes the two tools the host's `PluginIssueConnectorAdapter` calls:
 *   - `fetch_open_issues({ limit? })` → `{ issues: NormalizedIssue[] }`
 *   - `write_back_status({ externalId, status })` → `IssueWritebackResult`
 * plus `check_connection`. The host wraps these into the SAME ingest +
 * writeback pipeline the in-tree Obsidian connector uses (`sync_obsidian`,
 * `task_external_links`, checkbox-flip writeback).
 *
 * The in-tree connector ran a live chokidar watcher; a sandboxed plugin can't
 * push to the host, so the manifest declares `pollIntervalMs` and the HOST
 * polls `fetch_open_issues` on that cadence. Maestro can also drive
 * `sync_obsidian` on demand. Writeback flips the source checkbox
 * (`[ ]` → `[x]`) byte-preservingly.
 *
 * The vault path comes from `<install-dir>/config.json`. No token — a vault is
 * a local folder. stdout is the MCP channel; diagnostics go to stderr.
 */

class ConfigError extends Error {}

/**
 * One long-lived `ObsidianSource` for the process — built lazily on first use.
 * Like the in-tree connector, a single instance owns the per-file write-
 * serialization queue (`createVaultFs`'s `writeTails`), so two writebacks to
 * the same note in one tick order their atomic writes instead of racing. A
 * fresh instance per tool call would give each its own queue. Config is read
 * once (a change needs a restart), matching the in-tree boot-time lifecycle.
 */
let cachedSource: ObsidianSource | undefined;
function getSource(): ObsidianSource {
  cachedSource ??= new ObsidianSource(loadConfig());
  return cachedSource;
}

function loadConfig(): ObsidianSourceConfig {
  const file = path.join(process.cwd(), 'config.json');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(
      `obsidian-source is not configured — create ${file} with { "vaultPath": "/abs/path/to/vault" }`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = ObsidianSourceConfigSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
    throw new ConfigError(`config.json invalid${where}: ${first?.message ?? 'bad config'}`);
  }
  return parsed.data;
}

await createPlugin({
  id: 'obsidian-source-example',
  name: 'Obsidian source (example)',
  version: '0.1.0',
})
  .tool({
    name: 'fetch_open_issues',
    description:
      'Scan the configured Obsidian vault and return its checkbox tasks as NormalizedIssue[] (issue-source contract). Tasks already done ([x]) or cancelled ([-]) are flagged isTerminal so the host skips them.',
    inputSchema: {
      limit: z.number().int().min(1).max(2000).optional().describe('Max tasks to return.'),
    },
    handler: async ({ limit }) => {
      const issues = await getSource().fetchOpenIssues(limit);
      return { text: `Found ${issues.length} Obsidian task(s).`, structuredContent: { issues } };
    },
  })
  .tool({
    name: 'write_back_status',
    description:
      'Push a terminal task status to the vault by flipping the source checkbox: completed → the configured "completed" char (default x, optional ✅ done-date); failed → the "failed" char (only if configured).',
    inputSchema: {
      externalId: z.string().min(1).describe('<vault-relative-path>#<locator>'),
      status: z.enum(['completed', 'failed']),
    },
    handler: async ({ externalId, status }) => {
      const result = await getSource().writeBack(externalId, status);
      return {
        text: result.written
          ? `${externalId}: → [${result.value}]`
          : `${externalId}: ${result.code} (${result.reason ?? ''})`,
        structuredContent: { ...result },
      };
    },
  })
  .tool({
    name: 'check_connection',
    description: 'Verify the vault path exists and is readable.',
    handler: async () => {
      let source: ObsidianSource;
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

process.stderr.write('[obsidian-source] serving — Obsidian issue source for Symphony\n');
