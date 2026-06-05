import {
  loadGitHubConfig,
  saveGitHubConfig,
  GitHubConfigError,
  GITHUB_INTEGRATION,
  type GitHubConfig,
} from '../integrations/github-config.js';
import { saveToken, readToken } from '../integrations/secrets.js';
import { createGitHubConnectorFromDisk } from '../integrations/github.js';

/**
 * Phase 8C.2 — `symphony config github`. Stores the personal access token (OS
 * keychain, file fallback) + optional non-secret config (`github.json`: repos,
 * Enterprise base URL, writeback comments), or runs a connection check with
 * `--status`. Thin shell over `src/integrations/*`; returns an exit code
 * (mirrors `runLinearConfig`).
 */

export interface GitHubConfigCliResult {
  readonly exitCode: number;
}

export interface GitHubConfigCliOptions {
  readonly token?: string;
  /** One or more `owner/repo` slugs (repeatable `--repo`). Unioned with existing. */
  readonly repos?: readonly string[];
  readonly apiBaseUrl?: string;
  readonly writebackCompleted?: string;
  readonly writebackFailed?: string;
  /** `--status`: run a connection check instead of writing config. */
  readonly check?: boolean;
  /** Home override (tests). */
  readonly home?: string;
}

export async function runGitHubConfig(
  opts: GitHubConfigCliOptions,
): Promise<GitHubConfigCliResult> {
  if (opts.check === true) {
    return runConnectionCheck(opts.home);
  }

  const nothingToSet =
    opts.token === undefined &&
    (opts.repos === undefined || opts.repos.length === 0) &&
    opts.apiBaseUrl === undefined &&
    opts.writebackCompleted === undefined &&
    opts.writebackFailed === undefined;
  if (nothingToSet) {
    return showCurrentConfig(opts.home);
  }

  try {
    if (opts.token !== undefined) {
      await saveToken(GITHUB_INTEGRATION, opts.token, opts.home);
      console.log('[symphony] github: token stored (OS keychain, or ~/.symphony/integrations fallback).');
    }

    const patch: Partial<GitHubConfig> = {};
    if (opts.repos !== undefined && opts.repos.length > 0) patch.repos = [...opts.repos];
    if (opts.apiBaseUrl !== undefined) patch.apiBaseUrl = opts.apiBaseUrl;
    if (opts.writebackCompleted !== undefined || opts.writebackFailed !== undefined) {
      patch.statusWriteback = {
        ...(opts.writebackCompleted !== undefined ? { completed: opts.writebackCompleted } : {}),
        ...(opts.writebackFailed !== undefined ? { failed: opts.writebackFailed } : {}),
      };
    }

    let reposConfigured = false;
    if (Object.keys(patch).length > 0) {
      const saved = await saveGitHubConfig(patch, opts.home);
      reposConfigured = saved.repos.length > 0;
      console.log(
        `[symphony] github: configured (repos=${saved.repos.length > 0 ? saved.repos.join(', ') : 'none'}, ` +
          `api=${saved.apiBaseUrl ?? 'github.com'}, ` +
          `writeback completed='${saved.statusWriteback.completed ?? 'default'}', ` +
          `failed='${saved.statusWriteback.failed ?? 'off'}').`,
      );
    } else {
      // Token-only invocation skips the patch block — read disk to know whether
      // repos already exist (so a "store token, then add repos" flow gets the hint).
      reposConfigured = ((await loadGitHubConfig(opts.home))?.repos.length ?? 0) > 0;
    }
    if (!reposConfigured) {
      console.log('[symphony] github: add at least one repo with `--repo owner/name` to enable syncing.');
    }
    console.log('[symphony] github: run `symphony config github --status` to verify the connection.');
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof GitHubConfigError) {
      console.error(`[symphony] github: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
}

async function showCurrentConfig(home?: string): Promise<GitHubConfigCliResult> {
  let config: GitHubConfig | undefined;
  try {
    config = await loadGitHubConfig(home);
  } catch (err) {
    if (err instanceof GitHubConfigError) {
      console.error(`[symphony] github: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  const hasToken = (await readToken(GITHUB_INTEGRATION, home)) !== undefined;
  if (!hasToken && config === undefined) {
    console.log('[symphony] github: not configured.');
    console.log('  Configure with: symphony config github --token <pat> --repo owner/name');
    return { exitCode: 0 };
  }
  console.log('[symphony] github configuration:');
  console.log(`  token:     ${hasToken ? 'stored' : 'MISSING (run --token <pat>)'}`);
  console.log(`  repos:     ${config && config.repos.length > 0 ? config.repos.join(', ') : 'none (run --repo owner/name)'}`);
  console.log(`  api:       ${config?.apiBaseUrl ?? 'github.com'}`);
  console.log(`  writeback: completed='${config?.statusWriteback.completed ?? 'default'}', failed='${config?.statusWriteback.failed ?? 'off'}'`);
  return { exitCode: 0 };
}

async function runConnectionCheck(home?: string): Promise<GitHubConfigCliResult> {
  let connector;
  try {
    connector = await createGitHubConnectorFromDisk(
      home !== undefined ? { home, log: cliLog } : { log: cliLog },
    );
  } catch (err) {
    if (err instanceof GitHubConfigError) {
      console.error(`[symphony] github: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  if (connector === undefined) {
    console.error(
      '[symphony] github: not configured (missing token or no repos). ' +
        'Run `symphony config github --token <pat> --repo owner/name` first.',
    );
    return { exitCode: 1 };
  }
  const result = await connector.checkConnection();
  if (result.ok) {
    console.log('[symphony] github: connection OK.');
    if (result.detail !== undefined) console.log(`  ${result.detail}`);
    const issues = await connector.fetchOpenIssues({ limit: 1 }).catch(() => []);
    console.log(`  sample open issues found: ${issues.length}`);
    return { exitCode: 0 };
  }
  console.error(`[symphony] github: connection check failed: ${result.detail ?? 'unknown error'}`);
  return { exitCode: 1 };
}

function cliLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') console.error(`[symphony] github: ${message}`);
  else if (level === 'warn') console.warn(`[symphony] github: ${message}`);
}
