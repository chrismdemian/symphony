import {
  loadNotionConfig,
  saveNotionConfig,
  NotionConfigError,
  type NotionConfig,
} from '../integrations/notion-config.js';
import { saveToken, readToken } from '../integrations/secrets.js';
import {
  createNotionConnectorFromDisk,
  NotionError,
} from '../integrations/notion.js';
import { normalizeNotionId } from '../integrations/notion-client.js';
import { NOTION_INTEGRATION } from '../integrations/notion-config.js';

/**
 * Phase 8A — `symphony config notion`. Stores the token (0o600 file) +
 * non-secret config (`notion.json`), or runs a connection check with
 * `--status`. Thin shell over `src/integrations/*`; returns an exit code
 * (mirrors `runReset` / `runSkillsInstall`).
 */

export interface NotionConfigCliResult {
  readonly exitCode: number;
}

export interface NotionConfigCliOptions {
  readonly token?: string;
  readonly database?: string;
  readonly statusProp?: string;
  readonly projectProp?: string;
  readonly priorityProp?: string;
  /** `--status`: run a connection check instead of writing config. */
  readonly check?: boolean;
  /** Home override (tests). */
  readonly home?: string;
}

export async function runNotionConfig(
  opts: NotionConfigCliOptions,
): Promise<NotionConfigCliResult> {
  if (opts.check === true) {
    return runConnectionCheck(opts.home);
  }

  // Nothing to set + no check → show current config (or usage hint).
  const nothingToSet =
    opts.token === undefined &&
    opts.database === undefined &&
    opts.statusProp === undefined &&
    opts.projectProp === undefined &&
    opts.priorityProp === undefined;
  if (nothingToSet) {
    return showCurrentConfig(opts.home);
  }

  try {
    if (opts.token !== undefined) {
      await saveToken(NOTION_INTEGRATION, opts.token, opts.home);
      console.log('[symphony] notion: token stored (~/.symphony/integrations/notion-token, mode 0600).');
    }

    const patch: Partial<NotionConfig> & { databaseId?: string } = {};
    if (opts.database !== undefined) patch.databaseId = normalizeNotionId(opts.database);
    if (opts.statusProp !== undefined) patch.statusProperty = opts.statusProp;
    if (opts.projectProp !== undefined) patch.projectProperty = opts.projectProp;
    if (opts.priorityProp !== undefined) patch.priorityProperty = opts.priorityProp;

    // Only write the sidecar when there's a non-token field to persist, OR
    // when no config exists yet and a database was supplied. A token-only
    // invocation against an existing config touches nothing else.
    if (Object.keys(patch).length > 0) {
      const saved = await saveNotionConfig(patch, opts.home);
      console.log(
        `[symphony] notion: configured database ${saved.databaseId} ` +
          `(status='${saved.statusProperty}', project='${saved.projectProperty}', priority='${saved.priorityProperty}').`,
      );
    }
    console.log('[symphony] notion: run `symphony config notion --status` to verify the connection.');
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof NotionConfigError) {
      console.error(`[symphony] notion: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
}

async function showCurrentConfig(home?: string): Promise<NotionConfigCliResult> {
  let config: NotionConfig | undefined;
  try {
    config = await loadNotionConfig(home);
  } catch (err) {
    if (err instanceof NotionConfigError) {
      console.error(`[symphony] notion: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  if (config === undefined) {
    console.log('[symphony] notion: not configured.');
    console.log('  Configure with: symphony config notion --token <token> --database <id>');
    return { exitCode: 0 };
  }
  const hasToken = (await readToken(NOTION_INTEGRATION, home)) !== undefined;
  console.log('[symphony] notion configuration:');
  console.log(`  database:  ${config.databaseId}`);
  console.log(`  token:     ${hasToken ? 'stored' : 'MISSING (run --token <token>)'}`);
  console.log(`  status:    '${config.statusProperty}'`);
  console.log(`  project:   '${config.projectProperty}'`);
  console.log(`  priority:  '${config.priorityProperty}'`);
  return { exitCode: 0 };
}

async function runConnectionCheck(home?: string): Promise<NotionConfigCliResult> {
  let connector;
  try {
    connector = await createNotionConnectorFromDisk(
      home !== undefined
        ? { home, log: cliLog }
        : { log: cliLog },
    );
  } catch (err) {
    if (err instanceof NotionConfigError) {
      console.error(`[symphony] notion: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  if (connector === undefined) {
    console.error(
      '[symphony] notion: not fully configured (missing notion.json or token). ' +
        'Run `symphony config notion --token <token> --database <id>` first.',
    );
    return { exitCode: 1 };
  }
  try {
    const schema = await connector.resolveSchema();
    const pages = await connector.fetchOpenPages({ limit: 1 });
    console.log('[symphony] notion: connection OK.');
    console.log(`  data source: ${schema.dataSourceId}`);
    console.log(`  status property type: ${schema.statusPropType}`);
    console.log(`  sample open pages found: ${pages.length}`);
    return { exitCode: 0 };
  } catch (err) {
    const detail = err instanceof NotionError || err instanceof Error ? err.message : String(err);
    console.error(`[symphony] notion: connection check failed: ${detail}`);
    return { exitCode: 1 };
  }
}

function cliLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') console.error(`[symphony] notion: ${message}`);
  else if (level === 'warn') console.warn(`[symphony] notion: ${message}`);
}
