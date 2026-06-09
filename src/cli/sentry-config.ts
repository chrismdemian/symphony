import {
  loadSentryConfig,
  saveSentryConfig,
  SentryConfigError,
  SENTRY_INTEGRATION,
  type SentryConfig,
} from '../integrations/sentry-config.js';
import { saveToken, readToken } from '../integrations/secrets.js';
import { createSentryConnectorFromDisk } from '../integrations/sentry.js';

/**
 * Phase 8D.5 — `symphony config sentry`. Stores the auth token (OS keychain,
 * file fallback) + optional non-secret config (`sentry.json`: org, projects, the
 * instance base URL, writeback notes, the opt-in resolve flag), or runs a
 * connection check with `--status`. Thin shell over `src/integrations/*`; returns
 * an exit code (mirrors `runForgejoConfig`). Reading issues needs a token AND an
 * `--org` AND at least one `--project`.
 *
 * NOTE: `--token` is a Sentry AUTH TOKEN (scope `event:read`, + `event:write` for
 * `--writeback-resolve`), NOT a DSN (a DSN is a write-only ingestion key).
 */

export interface SentryConfigCliResult {
  readonly exitCode: number;
}

export interface SentryConfigCliOptions {
  readonly token?: string;
  readonly org?: string;
  /** One or more project slugs (repeatable `--project`). Unioned with existing. */
  readonly projects?: readonly string[];
  readonly baseUrl?: string;
  readonly writebackCompleted?: string;
  readonly writebackFailed?: string;
  /** `--writeback-resolve`: also mark the issue resolved on completion. */
  readonly writebackResolve?: boolean;
  /** `--status`: run a connection check instead of writing config. */
  readonly check?: boolean;
  /** Home override (tests). */
  readonly home?: string;
}

export async function runSentryConfig(
  opts: SentryConfigCliOptions,
): Promise<SentryConfigCliResult> {
  if (opts.check === true) {
    return runConnectionCheck(opts.home);
  }

  const nothingToSet =
    opts.token === undefined &&
    opts.org === undefined &&
    (opts.projects === undefined || opts.projects.length === 0) &&
    opts.baseUrl === undefined &&
    opts.writebackCompleted === undefined &&
    opts.writebackFailed === undefined &&
    opts.writebackResolve === undefined;
  if (nothingToSet) {
    return showCurrentConfig(opts.home);
  }

  try {
    if (opts.token !== undefined) {
      await saveToken(SENTRY_INTEGRATION, opts.token, opts.home);
      console.log('[symphony] sentry: token stored (OS keychain, or ~/.symphony/integrations fallback).');
    }

    const patch: Partial<SentryConfig> = {};
    if (opts.org !== undefined) patch.org = opts.org;
    if (opts.projects !== undefined && opts.projects.length > 0) patch.projects = [...opts.projects];
    if (opts.baseUrl !== undefined) patch.baseUrl = opts.baseUrl;
    if (opts.writebackResolve !== undefined) patch.resolveOnCompleted = opts.writebackResolve;
    if (opts.writebackCompleted !== undefined || opts.writebackFailed !== undefined) {
      patch.statusWriteback = {
        ...(opts.writebackCompleted !== undefined ? { completed: opts.writebackCompleted } : {}),
        ...(opts.writebackFailed !== undefined ? { failed: opts.writebackFailed } : {}),
      };
    }

    let orgConfigured = false;
    let projectsConfigured = false;
    if (Object.keys(patch).length > 0) {
      const saved = await saveSentryConfig(patch, opts.home);
      orgConfigured = saved.org !== undefined;
      projectsConfigured = saved.projects.length > 0;
      console.log(
        `[symphony] sentry: configured (org=${saved.org ?? 'MISSING'}, ` +
          `projects=${saved.projects.length > 0 ? saved.projects.join(', ') : 'none'}, ` +
          `base=${saved.baseUrl ?? 'https://sentry.io'}, ` +
          `resolve-on-completed=${saved.resolveOnCompleted}, ` +
          `writeback completed='${saved.statusWriteback.completed ?? 'default note'}', ` +
          `failed='${saved.statusWriteback.failed ?? 'off'}').`,
      );
    } else {
      // Token-only invocation skips the patch block — read disk to know whether
      // org/projects already exist (so a "store token, then add projects" flow gets the hint).
      const existing = await loadSentryConfig(opts.home);
      orgConfigured = existing?.org !== undefined;
      projectsConfigured = (existing?.projects.length ?? 0) > 0;
    }
    if (!orgConfigured) {
      console.log('[symphony] sentry: set your org with `--org <org-slug>` to enable syncing.');
    }
    if (!projectsConfigured) {
      console.log('[symphony] sentry: add at least one project with `--project <project-slug>` to enable syncing.');
    }
    console.log('[symphony] sentry: run `symphony config sentry --status` to verify the connection.');
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof SentryConfigError) {
      console.error(`[symphony] sentry: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
}

async function showCurrentConfig(home?: string): Promise<SentryConfigCliResult> {
  let config: SentryConfig | undefined;
  try {
    config = await loadSentryConfig(home);
  } catch (err) {
    if (err instanceof SentryConfigError) {
      console.error(`[symphony] sentry: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  const hasToken = (await readToken(SENTRY_INTEGRATION, home)) !== undefined;
  if (!hasToken && config === undefined) {
    console.log('[symphony] sentry: not configured.');
    console.log('  Configure with: symphony config sentry --token <auth-token> --org <org-slug> --project <project-slug>');
    return { exitCode: 0 };
  }
  console.log('[symphony] sentry configuration:');
  console.log(`  token:     ${hasToken ? 'stored' : 'MISSING (run --token <auth-token>)'}`);
  console.log(`  org:       ${config?.org ?? 'MISSING (run --org <org-slug>)'}`);
  console.log(`  projects:  ${config && config.projects.length > 0 ? config.projects.join(', ') : 'none (run --project <slug>)'}`);
  console.log(`  base:      ${config?.baseUrl ?? 'https://sentry.io'}`);
  console.log(`  writeback: completed note='${config?.statusWriteback.completed ?? 'default'}', failed='${config?.statusWriteback.failed ?? 'off'}', resolve-on-completed=${config?.resolveOnCompleted ?? false}`);
  return { exitCode: 0 };
}

async function runConnectionCheck(home?: string): Promise<SentryConfigCliResult> {
  let connector;
  try {
    connector = await createSentryConnectorFromDisk(
      home !== undefined ? { home, log: cliLog } : { log: cliLog },
    );
  } catch (err) {
    if (err instanceof SentryConfigError) {
      console.error(`[symphony] sentry: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  if (connector === undefined) {
    console.error(
      '[symphony] sentry: not configured (missing token, org, or projects). ' +
        'Run `symphony config sentry --token <auth-token> --org <org-slug> --project <project-slug>` first.',
    );
    return { exitCode: 1 };
  }
  const result = await connector.checkConnection();
  if (result.ok) {
    console.log('[symphony] sentry: connection OK.');
    if (result.detail !== undefined) console.log(`  ${result.detail}`);
    return { exitCode: 0 };
  }
  console.error(`[symphony] sentry: connection check failed: ${result.detail ?? 'unknown error'}`);
  return { exitCode: 1 };
}

function cliLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') console.error(`[symphony] sentry: ${message}`);
  else if (level === 'warn') console.warn(`[symphony] sentry: ${message}`);
}
