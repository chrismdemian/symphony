import {
  loadLinearConfig,
  saveLinearConfig,
  LinearConfigError,
  LINEAR_INTEGRATION,
  type LinearConfig,
} from '../integrations/linear-config.js';
import { saveToken, readToken } from '../integrations/secrets.js';
import { createLinearConnectorFromDisk } from '../integrations/linear.js';

/**
 * Phase 8C — `symphony config linear`. Stores the API key (OS keychain, file
 * fallback) + optional non-secret config (`linear.json`), or runs a connection
 * check with `--status`. Thin shell over `src/integrations/*`; returns an exit
 * code (mirrors `runNotionConfig`).
 */

export interface LinearConfigCliResult {
  readonly exitCode: number;
}

export interface LinearConfigCliOptions {
  readonly token?: string;
  readonly team?: string;
  readonly writebackCompleted?: string;
  readonly writebackFailed?: string;
  /** `--status`: run a connection check instead of writing config. */
  readonly check?: boolean;
  /** Home override (tests). */
  readonly home?: string;
}

export async function runLinearConfig(
  opts: LinearConfigCliOptions,
): Promise<LinearConfigCliResult> {
  if (opts.check === true) {
    return runConnectionCheck(opts.home);
  }

  const nothingToSet =
    opts.token === undefined &&
    opts.team === undefined &&
    opts.writebackCompleted === undefined &&
    opts.writebackFailed === undefined;
  if (nothingToSet) {
    return showCurrentConfig(opts.home);
  }

  try {
    if (opts.token !== undefined) {
      await saveToken(LINEAR_INTEGRATION, opts.token, opts.home);
      console.log('[symphony] linear: API key stored (OS keychain, or ~/.symphony/integrations fallback).');
    }

    const patch: Partial<LinearConfig> = {};
    if (opts.team !== undefined) patch.teamKey = opts.team;
    if (opts.writebackCompleted !== undefined || opts.writebackFailed !== undefined) {
      patch.statusWriteback = {
        ...(opts.writebackCompleted !== undefined ? { completed: opts.writebackCompleted } : {}),
        ...(opts.writebackFailed !== undefined ? { failed: opts.writebackFailed } : {}),
      };
    }

    if (Object.keys(patch).length > 0) {
      const saved = await saveLinearConfig(patch, opts.home);
      console.log(
        `[symphony] linear: configured (team=${saved.teamKey ?? 'all'}, ` +
          `writeback completed='${saved.statusWriteback.completed ?? 'auto'}', ` +
          `failed='${saved.statusWriteback.failed ?? 'off'}').`,
      );
    }
    console.log('[symphony] linear: run `symphony config linear --status` to verify the connection.');
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof LinearConfigError) {
      console.error(`[symphony] linear: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
}

async function showCurrentConfig(home?: string): Promise<LinearConfigCliResult> {
  let config: LinearConfig | undefined;
  try {
    config = await loadLinearConfig(home);
  } catch (err) {
    if (err instanceof LinearConfigError) {
      console.error(`[symphony] linear: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  const hasToken = (await readToken(LINEAR_INTEGRATION, home)) !== undefined;
  if (!hasToken && config === undefined) {
    console.log('[symphony] linear: not configured.');
    console.log('  Configure with: symphony config linear --token <api-key>');
    return { exitCode: 0 };
  }
  console.log('[symphony] linear configuration:');
  console.log(`  api key:   ${hasToken ? 'stored' : 'MISSING (run --token <api-key>)'}`);
  console.log(`  team:      ${config?.teamKey ?? 'all teams'}`);
  console.log(`  writeback: completed='${config?.statusWriteback.completed ?? 'auto'}', failed='${config?.statusWriteback.failed ?? 'off'}'`);
  return { exitCode: 0 };
}

async function runConnectionCheck(home?: string): Promise<LinearConfigCliResult> {
  let connector;
  try {
    connector = await createLinearConnectorFromDisk(
      home !== undefined ? { home, log: cliLog } : { log: cliLog },
    );
  } catch (err) {
    if (err instanceof LinearConfigError) {
      console.error(`[symphony] linear: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  if (connector === undefined) {
    console.error(
      '[symphony] linear: not configured (missing API key). ' +
        'Run `symphony config linear --token <api-key>` first.',
    );
    return { exitCode: 1 };
  }
  const result = await connector.checkConnection();
  if (result.ok) {
    console.log('[symphony] linear: connection OK.');
    if (result.detail !== undefined) console.log(`  ${result.detail}`);
    const issues = await connector.fetchOpenIssues({ limit: 1 }).catch(() => []);
    console.log(`  sample recent issues found: ${issues.length}`);
    return { exitCode: 0 };
  }
  console.error(`[symphony] linear: connection check failed: ${result.detail ?? 'unknown error'}`);
  return { exitCode: 1 };
}

function cliLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') console.error(`[symphony] linear: ${message}`);
  else if (level === 'warn') console.warn(`[symphony] linear: ${message}`);
}
