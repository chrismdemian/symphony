import {
  loadForgejoConfig,
  saveForgejoConfig,
  ForgejoConfigError,
  FORGEJO_INTEGRATION,
  type ForgejoConfig,
} from '../integrations/forgejo-config.js';
import { saveToken, readToken } from '../integrations/secrets.js';
import { createForgejoConnectorFromDisk } from '../integrations/forgejo.js';

/**
 * Phase 8C.4 — `symphony config forgejo`. Stores the personal access token (OS
 * keychain, file fallback) + optional non-secret config (`forgejo.json`: repos,
 * the self-hosted instance URL, writeback comments), or runs a connection check
 * with `--status`. Thin shell over `src/integrations/*`; returns an exit code
 * (mirrors `runGitLabConfig`). Forgejo is always self-hosted, so both a
 * `--site-url` AND at least one `--repo` are required to enable syncing.
 */

export interface ForgejoConfigCliResult {
  readonly exitCode: number;
}

export interface ForgejoConfigCliOptions {
  readonly token?: string;
  /** One or more `owner/repo` slugs (repeatable `--repo`). Unioned with existing. */
  readonly repos?: readonly string[];
  readonly siteUrl?: string;
  readonly writebackCompleted?: string;
  readonly writebackFailed?: string;
  /** `--status`: run a connection check instead of writing config. */
  readonly check?: boolean;
  /** Home override (tests). */
  readonly home?: string;
}

export async function runForgejoConfig(
  opts: ForgejoConfigCliOptions,
): Promise<ForgejoConfigCliResult> {
  if (opts.check === true) {
    return runConnectionCheck(opts.home);
  }

  const nothingToSet =
    opts.token === undefined &&
    (opts.repos === undefined || opts.repos.length === 0) &&
    opts.siteUrl === undefined &&
    opts.writebackCompleted === undefined &&
    opts.writebackFailed === undefined;
  if (nothingToSet) {
    return showCurrentConfig(opts.home);
  }

  try {
    if (opts.token !== undefined) {
      await saveToken(FORGEJO_INTEGRATION, opts.token, opts.home);
      console.log('[symphony] forgejo: token stored (OS keychain, or ~/.symphony/integrations fallback).');
    }

    const patch: Partial<ForgejoConfig> = {};
    if (opts.repos !== undefined && opts.repos.length > 0) patch.repos = [...opts.repos];
    if (opts.siteUrl !== undefined) patch.siteUrl = opts.siteUrl;
    if (opts.writebackCompleted !== undefined || opts.writebackFailed !== undefined) {
      patch.statusWriteback = {
        ...(opts.writebackCompleted !== undefined ? { completed: opts.writebackCompleted } : {}),
        ...(opts.writebackFailed !== undefined ? { failed: opts.writebackFailed } : {}),
      };
    }

    let reposConfigured = false;
    let siteConfigured = false;
    if (Object.keys(patch).length > 0) {
      const saved = await saveForgejoConfig(patch, opts.home);
      reposConfigured = saved.repos.length > 0;
      siteConfigured = saved.siteUrl !== undefined;
      console.log(
        `[symphony] forgejo: configured (repos=${saved.repos.length > 0 ? saved.repos.join(', ') : 'none'}, ` +
          `site=${saved.siteUrl ?? 'MISSING'}, ` +
          `writeback completed='${saved.statusWriteback.completed ?? 'default'}', ` +
          `failed='${saved.statusWriteback.failed ?? 'off'}').`,
      );
    } else {
      // Token-only invocation skips the patch block — read disk to know whether
      // repos/site already exist (so a "store token, then add repos" flow gets the hint).
      const existing = await loadForgejoConfig(opts.home);
      reposConfigured = (existing?.repos.length ?? 0) > 0;
      siteConfigured = existing?.siteUrl !== undefined;
    }
    if (!siteConfigured) {
      console.log('[symphony] forgejo: set your instance URL with `--site-url https://code.example.com` to enable syncing.');
    }
    if (!reposConfigured) {
      console.log('[symphony] forgejo: add at least one repo with `--repo owner/name` to enable syncing.');
    }
    console.log('[symphony] forgejo: run `symphony config forgejo --status` to verify the connection.');
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof ForgejoConfigError) {
      console.error(`[symphony] forgejo: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
}

async function showCurrentConfig(home?: string): Promise<ForgejoConfigCliResult> {
  let config: ForgejoConfig | undefined;
  try {
    config = await loadForgejoConfig(home);
  } catch (err) {
    if (err instanceof ForgejoConfigError) {
      console.error(`[symphony] forgejo: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  const hasToken = (await readToken(FORGEJO_INTEGRATION, home)) !== undefined;
  if (!hasToken && config === undefined) {
    console.log('[symphony] forgejo: not configured.');
    console.log('  Configure with: symphony config forgejo --token <pat> --site-url https://code.example.com --repo owner/name');
    return { exitCode: 0 };
  }
  console.log('[symphony] forgejo configuration:');
  console.log(`  token:     ${hasToken ? 'stored' : 'MISSING (run --token <pat>)'}`);
  console.log(`  site:      ${config?.siteUrl ?? 'MISSING (run --site-url <url>)'}`);
  console.log(`  repos:     ${config && config.repos.length > 0 ? config.repos.join(', ') : 'none (run --repo owner/name)'}`);
  console.log(`  writeback: completed='${config?.statusWriteback.completed ?? 'default'}', failed='${config?.statusWriteback.failed ?? 'off'}'`);
  return { exitCode: 0 };
}

async function runConnectionCheck(home?: string): Promise<ForgejoConfigCliResult> {
  let connector;
  try {
    connector = await createForgejoConnectorFromDisk(
      home !== undefined ? { home, log: cliLog } : { log: cliLog },
    );
  } catch (err) {
    if (err instanceof ForgejoConfigError) {
      console.error(`[symphony] forgejo: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  if (connector === undefined) {
    console.error(
      '[symphony] forgejo: not configured (missing token, site URL, or repos). ' +
        'Run `symphony config forgejo --token <pat> --site-url https://code.example.com --repo owner/name` first.',
    );
    return { exitCode: 1 };
  }
  const result = await connector.checkConnection();
  if (result.ok) {
    console.log('[symphony] forgejo: connection OK.');
    if (result.detail !== undefined) console.log(`  ${result.detail}`);
    const issues = await connector.fetchOpenIssues({ limit: 1 }).catch(() => []);
    console.log(`  sample open issues found: ${issues.length}`);
    return { exitCode: 0 };
  }
  console.error(`[symphony] forgejo: connection check failed: ${result.detail ?? 'unknown error'}`);
  return { exitCode: 1 };
}

function cliLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') console.error(`[symphony] forgejo: ${message}`);
  else if (level === 'warn') console.warn(`[symphony] forgejo: ${message}`);
}
