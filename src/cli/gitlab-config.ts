import {
  loadGitLabConfig,
  saveGitLabConfig,
  GitLabConfigError,
  GITLAB_INTEGRATION,
  type GitLabConfig,
} from '../integrations/gitlab-config.js';
import { saveToken, readToken } from '../integrations/secrets.js';
import { createGitLabConnectorFromDisk } from '../integrations/gitlab.js';

/**
 * Phase 8C.3 — `symphony config gitlab`. Stores the personal access token (OS
 * keychain, file fallback) + optional non-secret config (`gitlab.json`:
 * projects, self-hosted site URL, writeback notes), or runs a connection check
 * with `--status`. Thin shell over `src/integrations/*`; returns an exit code
 * (mirrors `runGitHubConfig`).
 */

export interface GitLabConfigCliResult {
  readonly exitCode: number;
}

export interface GitLabConfigCliOptions {
  readonly token?: string;
  /** One or more `group/project` paths (repeatable `--project`). Unioned with existing. */
  readonly projects?: readonly string[];
  readonly siteUrl?: string;
  readonly writebackCompleted?: string;
  readonly writebackFailed?: string;
  /** `--status`: run a connection check instead of writing config. */
  readonly check?: boolean;
  /** Home override (tests). */
  readonly home?: string;
}

export async function runGitLabConfig(
  opts: GitLabConfigCliOptions,
): Promise<GitLabConfigCliResult> {
  if (opts.check === true) {
    return runConnectionCheck(opts.home);
  }

  const nothingToSet =
    opts.token === undefined &&
    (opts.projects === undefined || opts.projects.length === 0) &&
    opts.siteUrl === undefined &&
    opts.writebackCompleted === undefined &&
    opts.writebackFailed === undefined;
  if (nothingToSet) {
    return showCurrentConfig(opts.home);
  }

  try {
    if (opts.token !== undefined) {
      await saveToken(GITLAB_INTEGRATION, opts.token, opts.home);
      console.log('[symphony] gitlab: token stored (OS keychain, or ~/.symphony/integrations fallback).');
    }

    const patch: Partial<GitLabConfig> = {};
    if (opts.projects !== undefined && opts.projects.length > 0) patch.projects = [...opts.projects];
    if (opts.siteUrl !== undefined) patch.siteUrl = opts.siteUrl;
    if (opts.writebackCompleted !== undefined || opts.writebackFailed !== undefined) {
      patch.statusWriteback = {
        ...(opts.writebackCompleted !== undefined ? { completed: opts.writebackCompleted } : {}),
        ...(opts.writebackFailed !== undefined ? { failed: opts.writebackFailed } : {}),
      };
    }

    let projectsConfigured = false;
    if (Object.keys(patch).length > 0) {
      const saved = await saveGitLabConfig(patch, opts.home);
      projectsConfigured = saved.projects.length > 0;
      console.log(
        `[symphony] gitlab: configured (projects=${saved.projects.length > 0 ? saved.projects.join(', ') : 'none'}, ` +
          `site=${saved.siteUrl ?? 'gitlab.com'}, ` +
          `writeback completed='${saved.statusWriteback.completed ?? 'default'}', ` +
          `failed='${saved.statusWriteback.failed ?? 'off'}').`,
      );
    } else {
      // Token-only invocation skips the patch block — read disk to know whether
      // projects already exist (so a "store token, then add projects" flow gets the hint).
      projectsConfigured = ((await loadGitLabConfig(opts.home))?.projects.length ?? 0) > 0;
    }
    if (!projectsConfigured) {
      console.log('[symphony] gitlab: add at least one project with `--project group/name` to enable syncing.');
    }
    console.log('[symphony] gitlab: run `symphony config gitlab --status` to verify the connection.');
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof GitLabConfigError) {
      console.error(`[symphony] gitlab: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
}

async function showCurrentConfig(home?: string): Promise<GitLabConfigCliResult> {
  let config: GitLabConfig | undefined;
  try {
    config = await loadGitLabConfig(home);
  } catch (err) {
    if (err instanceof GitLabConfigError) {
      console.error(`[symphony] gitlab: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  const hasToken = (await readToken(GITLAB_INTEGRATION, home)) !== undefined;
  if (!hasToken && config === undefined) {
    console.log('[symphony] gitlab: not configured.');
    console.log('  Configure with: symphony config gitlab --token <pat> --project group/name');
    return { exitCode: 0 };
  }
  console.log('[symphony] gitlab configuration:');
  console.log(`  token:     ${hasToken ? 'stored' : 'MISSING (run --token <pat>)'}`);
  console.log(`  projects:  ${config && config.projects.length > 0 ? config.projects.join(', ') : 'none (run --project group/name)'}`);
  console.log(`  site:      ${config?.siteUrl ?? 'gitlab.com'}`);
  console.log(`  writeback: completed='${config?.statusWriteback.completed ?? 'default'}', failed='${config?.statusWriteback.failed ?? 'off'}'`);
  return { exitCode: 0 };
}

async function runConnectionCheck(home?: string): Promise<GitLabConfigCliResult> {
  let connector;
  try {
    connector = await createGitLabConnectorFromDisk(
      home !== undefined ? { home, log: cliLog } : { log: cliLog },
    );
  } catch (err) {
    if (err instanceof GitLabConfigError) {
      console.error(`[symphony] gitlab: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  if (connector === undefined) {
    console.error(
      '[symphony] gitlab: not configured (missing token or no projects). ' +
        'Run `symphony config gitlab --token <pat> --project group/name` first.',
    );
    return { exitCode: 1 };
  }
  const result = await connector.checkConnection();
  if (result.ok) {
    console.log('[symphony] gitlab: connection OK.');
    if (result.detail !== undefined) console.log(`  ${result.detail}`);
    const issues = await connector.fetchOpenIssues({ limit: 1 }).catch(() => []);
    console.log(`  sample open issues found: ${issues.length}`);
    return { exitCode: 0 };
  }
  console.error(`[symphony] gitlab: connection check failed: ${result.detail ?? 'unknown error'}`);
  return { exitCode: 1 };
}

function cliLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') console.error(`[symphony] gitlab: ${message}`);
  else if (level === 'warn') console.warn(`[symphony] gitlab: ${message}`);
}
