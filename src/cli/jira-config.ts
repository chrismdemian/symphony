import {
  loadJiraConfig,
  saveJiraConfig,
  JiraConfigError,
  JIRA_INTEGRATION,
  type JiraConfig,
} from '../integrations/jira-config.js';
import { saveToken, readToken } from '../integrations/secrets.js';
import { createJiraConnectorFromDisk } from '../integrations/jira.js';

/**
 * Phase 8C.3 — `symphony config jira`. Stores the API token (OS keychain, file
 * fallback) + non-secret config (`jira.json`: site URL, account email, project
 * keys, writeback comments + transition override), or runs a connection check
 * with `--status`. Thin shell over `src/integrations/*`; returns an exit code
 * (mirrors `runGitHubConfig`).
 */

export interface JiraConfigCliResult {
  readonly exitCode: number;
}

export interface JiraConfigCliOptions {
  readonly token?: string;
  readonly siteUrl?: string;
  readonly email?: string;
  /** One or more project keys (repeatable `--project`). Unioned with existing. */
  readonly projectKeys?: readonly string[];
  readonly writebackCompleted?: string;
  readonly writebackFailed?: string;
  readonly writebackTransition?: string;
  /** `--status`: run a connection check instead of writing config. */
  readonly check?: boolean;
  /** Home override (tests). */
  readonly home?: string;
}

export async function runJiraConfig(opts: JiraConfigCliOptions): Promise<JiraConfigCliResult> {
  if (opts.check === true) {
    return runConnectionCheck(opts.home);
  }

  const nothingToSet =
    opts.token === undefined &&
    opts.siteUrl === undefined &&
    opts.email === undefined &&
    (opts.projectKeys === undefined || opts.projectKeys.length === 0) &&
    opts.writebackCompleted === undefined &&
    opts.writebackFailed === undefined &&
    opts.writebackTransition === undefined;
  if (nothingToSet) {
    return showCurrentConfig(opts.home);
  }

  try {
    if (opts.token !== undefined) {
      await saveToken(JIRA_INTEGRATION, opts.token, opts.home);
      console.log('[symphony] jira: token stored (OS keychain, or ~/.symphony/integrations fallback).');
    }

    const patch: Partial<JiraConfig> = {};
    if (opts.siteUrl !== undefined) patch.siteUrl = opts.siteUrl;
    if (opts.email !== undefined) patch.email = opts.email;
    if (opts.projectKeys !== undefined && opts.projectKeys.length > 0) {
      patch.projectKeys = [...opts.projectKeys];
    }
    if (
      opts.writebackCompleted !== undefined ||
      opts.writebackFailed !== undefined ||
      opts.writebackTransition !== undefined
    ) {
      patch.statusWriteback = {
        ...(opts.writebackCompleted !== undefined ? { completed: opts.writebackCompleted } : {}),
        ...(opts.writebackFailed !== undefined ? { failed: opts.writebackFailed } : {}),
        ...(opts.writebackTransition !== undefined
          ? { completedTransition: opts.writebackTransition }
          : {}),
      };
    }

    let activatable = false;
    if (Object.keys(patch).length > 0) {
      const saved = await saveJiraConfig(patch, opts.home);
      activatable = saved.siteUrl !== undefined && saved.email !== undefined;
      console.log(
        `[symphony] jira: configured (site=${saved.siteUrl ?? 'MISSING'}, ` +
          `email=${saved.email ?? 'MISSING'}, ` +
          `projects=${saved.projectKeys.length > 0 ? saved.projectKeys.join(', ') : 'none'}, ` +
          `writeback completed='${saved.statusWriteback.completed ?? 'default'}', ` +
          `transition='${saved.statusWriteback.completedTransition ?? 'auto (first Done)'}', ` +
          `failed='${saved.statusWriteback.failed ?? 'off'}').`,
      );
    } else {
      // Token-only invocation — read disk to know whether site+email already exist.
      const existing = await loadJiraConfig(opts.home);
      activatable = existing?.siteUrl !== undefined && existing.email !== undefined;
    }
    if (!activatable) {
      console.log('[symphony] jira: set `--site-url https://you.atlassian.net --email you@example.com` to enable syncing.');
    }
    console.log('[symphony] jira: run `symphony config jira --status` to verify the connection.');
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof JiraConfigError) {
      console.error(`[symphony] jira: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
}

async function showCurrentConfig(home?: string): Promise<JiraConfigCliResult> {
  let config: JiraConfig | undefined;
  try {
    config = await loadJiraConfig(home);
  } catch (err) {
    if (err instanceof JiraConfigError) {
      console.error(`[symphony] jira: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  const hasToken = (await readToken(JIRA_INTEGRATION, home)) !== undefined;
  if (!hasToken && config === undefined) {
    console.log('[symphony] jira: not configured.');
    console.log(
      '  Configure with: symphony config jira --token <api-token> --site-url https://you.atlassian.net --email you@example.com',
    );
    return { exitCode: 0 };
  }
  console.log('[symphony] jira configuration:');
  console.log(`  token:     ${hasToken ? 'stored' : 'MISSING (run --token <api-token>)'}`);
  console.log(`  site:      ${config?.siteUrl ?? 'MISSING (run --site-url https://you.atlassian.net)'}`);
  console.log(`  email:     ${config?.email ?? 'MISSING (run --email you@example.com)'}`);
  console.log(`  projects:  ${config && config.projectKeys.length > 0 ? config.projectKeys.join(', ') : 'none (optional; run --project ENG)'}`);
  console.log(
    `  writeback: completed='${config?.statusWriteback.completed ?? 'default'}', ` +
      `transition='${config?.statusWriteback.completedTransition ?? 'auto (first Done)'}', ` +
      `failed='${config?.statusWriteback.failed ?? 'off'}'`,
  );
  return { exitCode: 0 };
}

async function runConnectionCheck(home?: string): Promise<JiraConfigCliResult> {
  let connector;
  try {
    connector = await createJiraConnectorFromDisk(
      home !== undefined ? { home, log: cliLog } : { log: cliLog },
    );
  } catch (err) {
    if (err instanceof JiraConfigError) {
      console.error(`[symphony] jira: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  if (connector === undefined) {
    console.error(
      '[symphony] jira: not configured (missing token, site URL, or email). ' +
        'Run `symphony config jira --token <api-token> --site-url https://you.atlassian.net --email you@example.com` first.',
    );
    return { exitCode: 1 };
  }
  const result = await connector.checkConnection();
  if (result.ok) {
    console.log('[symphony] jira: connection OK.');
    if (result.detail !== undefined) console.log(`  ${result.detail}`);
    const issues = await connector.fetchOpenIssues({ limit: 1 }).catch(() => []);
    console.log(`  sample open issues found: ${issues.length}`);
    return { exitCode: 0 };
  }
  console.error(`[symphony] jira: connection check failed: ${result.detail ?? 'unknown error'}`);
  return { exitCode: 1 };
}

function cliLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') console.error(`[symphony] jira: ${message}`);
  else if (level === 'warn') console.warn(`[symphony] jira: ${message}`);
}
