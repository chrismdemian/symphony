import {
  loadPlainConfig,
  savePlainConfig,
  PlainConfigError,
  PLAIN_INTEGRATION,
  PLAIN_THREAD_STATUSES,
  type PlainConfig,
  type PlainThreadStatus,
} from '../integrations/plain-config.js';
import { saveToken, readToken } from '../integrations/secrets.js';
import { createPlainConnectorFromDisk } from '../integrations/plain.js';

/**
 * Phase 8C.4 — `symphony config plain`. Stores the Plain API key (OS keychain,
 * file fallback) + optional non-secret config (`plain.json`: API endpoint, which
 * thread statuses to import, writeback notes), or runs a connection check with
 * `--status`. Thin shell over `src/integrations/*`; returns an exit code. Like
 * Linear, Plain activates on a token ALONE (no required repos/projects).
 */

export interface PlainConfigCliResult {
  readonly exitCode: number;
}

export interface PlainConfigCliOptions {
  readonly token?: string;
  readonly apiUrl?: string;
  /** Which thread statuses to import (replaces the existing list when given). */
  readonly statuses?: readonly string[];
  readonly writebackCompleted?: string;
  readonly writebackFailed?: string;
  /** `--status`: run a connection check instead of writing config. */
  readonly check?: boolean;
  /** Home override (tests). */
  readonly home?: string;
}

export async function runPlainConfig(opts: PlainConfigCliOptions): Promise<PlainConfigCliResult> {
  if (opts.check === true) {
    return runConnectionCheck(opts.home);
  }

  const nothingToSet =
    opts.token === undefined &&
    opts.apiUrl === undefined &&
    (opts.statuses === undefined || opts.statuses.length === 0) &&
    opts.writebackCompleted === undefined &&
    opts.writebackFailed === undefined;
  if (nothingToSet) {
    return showCurrentConfig(opts.home);
  }

  try {
    if (opts.token !== undefined) {
      await saveToken(PLAIN_INTEGRATION, opts.token, opts.home);
      console.log('[symphony] plain: token stored (OS keychain, or ~/.symphony/integrations fallback).');
    }

    const patch: Partial<PlainConfig> = {};
    if (opts.apiUrl !== undefined) patch.apiUrl = opts.apiUrl;
    if (opts.statuses !== undefined && opts.statuses.length > 0) {
      patch.statuses = normalizeStatuses(opts.statuses);
    }
    if (opts.writebackCompleted !== undefined || opts.writebackFailed !== undefined) {
      patch.statusWriteback = {
        ...(opts.writebackCompleted !== undefined ? { completed: opts.writebackCompleted } : {}),
        ...(opts.writebackFailed !== undefined ? { failed: opts.writebackFailed } : {}),
      };
    }

    if (Object.keys(patch).length > 0) {
      const saved = await savePlainConfig(patch, opts.home);
      console.log(
        `[symphony] plain: configured (api=${saved.apiUrl ?? 'default (uk region)'}, ` +
          `statuses=${saved.statuses.join(', ')}, ` +
          `writeback completed='${saved.statusWriteback.completed ?? 'default'}', ` +
          `failed='${saved.statusWriteback.failed ?? 'off'}').`,
      );
    }
    console.log('[symphony] plain: run `symphony config plain --status` to verify the connection.');
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof PlainConfigError) {
      console.error(`[symphony] plain: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
}

/** Uppercase + validate against Plain's three statuses; throws on an unknown value. */
function normalizeStatuses(input: readonly string[]): [PlainThreadStatus, ...PlainThreadStatus[]] {
  const out: PlainThreadStatus[] = [];
  for (const raw of input) {
    const up = raw.trim().toUpperCase();
    const match = PLAIN_THREAD_STATUSES.find((s) => s === up);
    if (match === undefined) {
      throw new PlainConfigError(
        `unknown thread status '${raw}' (expected one of ${PLAIN_THREAD_STATUSES.join(', ')})`,
      );
    }
    if (!out.includes(match)) out.push(match);
  }
  if (out.length === 0) {
    throw new PlainConfigError('at least one thread status is required');
  }
  return out as [PlainThreadStatus, ...PlainThreadStatus[]];
}

async function showCurrentConfig(home?: string): Promise<PlainConfigCliResult> {
  let config: PlainConfig | undefined;
  try {
    config = await loadPlainConfig(home);
  } catch (err) {
    if (err instanceof PlainConfigError) {
      console.error(`[symphony] plain: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  const hasToken = (await readToken(PLAIN_INTEGRATION, home)) !== undefined;
  if (!hasToken && config === undefined) {
    console.log('[symphony] plain: not configured.');
    console.log('  Configure with: symphony config plain --token <api-key>');
    return { exitCode: 0 };
  }
  console.log('[symphony] plain configuration:');
  console.log(`  token:     ${hasToken ? 'stored' : 'MISSING (run --token <api-key>)'}`);
  console.log(`  api:       ${config?.apiUrl ?? 'default (uk region)'}`);
  console.log(`  statuses:  ${config && config.statuses.length > 0 ? config.statuses.join(', ') : 'TODO (default)'}`);
  console.log(`  writeback: completed='${config?.statusWriteback.completed ?? 'default'}', failed='${config?.statusWriteback.failed ?? 'off'}'`);
  return { exitCode: 0 };
}

async function runConnectionCheck(home?: string): Promise<PlainConfigCliResult> {
  let connector;
  try {
    connector = await createPlainConnectorFromDisk(
      home !== undefined ? { home, log: cliLog } : { log: cliLog },
    );
  } catch (err) {
    if (err instanceof PlainConfigError) {
      console.error(`[symphony] plain: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  if (connector === undefined) {
    console.error(
      '[symphony] plain: not configured (missing token). Run `symphony config plain --token <api-key>` first.',
    );
    return { exitCode: 1 };
  }
  const result = await connector.checkConnection();
  if (result.ok) {
    console.log('[symphony] plain: connection OK.');
    if (result.detail !== undefined) console.log(`  ${result.detail}`);
    const issues = await connector.fetchOpenIssues({ limit: 1 }).catch(() => []);
    console.log(`  sample open threads found: ${issues.length}`);
    return { exitCode: 0 };
  }
  console.error(`[symphony] plain: connection check failed: ${result.detail ?? 'unknown error'}`);
  return { exitCode: 1 };
}

function cliLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') console.error(`[symphony] plain: ${message}`);
  else if (level === 'warn') console.warn(`[symphony] plain: ${message}`);
}
