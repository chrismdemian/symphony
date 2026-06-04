import {
  loadObsidianConfig,
  saveObsidianConfig,
  ObsidianConfigError,
  type ObsidianConfig,
} from '../integrations/obsidian-config.js';
import {
  createObsidianConnectorFromDisk,
  ObsidianError,
} from '../integrations/obsidian.js';

/**
 * Phase 8B — `symphony config obsidian`. Stores the non-secret config
 * (`obsidian.json` — vault path, task format, routing), or runs a vault
 * check with `--status`. No token: a vault is a local folder. Thin shell
 * over `src/integrations/*`; returns an exit code (mirrors `runNotionConfig`).
 */

export interface ObsidianConfigCliResult {
  readonly exitCode: number;
}

export interface ObsidianConfigCliOptions {
  readonly vault?: string;
  readonly projectProp?: string;
  readonly taskFormat?: string;
  /** `--watch` / `--no-watch`: toggle the live vault watcher. */
  readonly watch?: boolean;
  /** `--status`: run a vault check instead of writing config. */
  readonly check?: boolean;
  /** Home override (tests). */
  readonly home?: string;
}

const VALID_FORMATS = new Set(['emoji', 'dataview', 'auto']);

export async function runObsidianConfig(
  opts: ObsidianConfigCliOptions,
): Promise<ObsidianConfigCliResult> {
  if (opts.check === true) {
    return runVaultCheck(opts.home);
  }

  const nothingToSet =
    opts.vault === undefined &&
    opts.projectProp === undefined &&
    opts.taskFormat === undefined &&
    opts.watch === undefined;
  if (nothingToSet) {
    return showCurrentConfig(opts.home);
  }

  if (opts.taskFormat !== undefined && !VALID_FORMATS.has(opts.taskFormat)) {
    console.error(
      `[symphony] obsidian: invalid --task-format '${opts.taskFormat}' (expected emoji | dataview | auto).`,
    );
    return { exitCode: 1 };
  }

  try {
    const patch: Partial<ObsidianConfig> & { vaultPath?: string } = {};
    if (opts.vault !== undefined) patch.vaultPath = opts.vault;
    if (opts.projectProp !== undefined) patch.projectProperty = opts.projectProp;
    if (opts.taskFormat !== undefined) {
      patch.taskFormat = opts.taskFormat as ObsidianConfig['taskFormat'];
    }
    if (opts.watch !== undefined) patch.watch = opts.watch;

    const saved = await saveObsidianConfig(patch, opts.home);
    console.log(
      `[symphony] obsidian: configured vault ${saved.vaultPath} ` +
        `(format='${saved.taskFormat}', project='${saved.projectProperty}', watch=${saved.watch}).`,
    );
    console.log('[symphony] obsidian: run `symphony config obsidian --status` to verify the vault.');
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof ObsidianConfigError) {
      console.error(`[symphony] obsidian: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
}

async function showCurrentConfig(home?: string): Promise<ObsidianConfigCliResult> {
  let config: ObsidianConfig | undefined;
  try {
    config = await loadObsidianConfig(home);
  } catch (err) {
    if (err instanceof ObsidianConfigError) {
      console.error(`[symphony] obsidian: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  if (config === undefined) {
    console.log('[symphony] obsidian: not configured.');
    console.log('  Configure with: symphony config obsidian --vault <path>');
    return { exitCode: 0 };
  }
  console.log('[symphony] obsidian configuration:');
  console.log(`  vault:     ${config.vaultPath}`);
  console.log(`  format:    '${config.taskFormat}'`);
  console.log(`  project:   '${config.projectProperty}'`);
  console.log(`  watch:     ${config.watch}`);
  return { exitCode: 0 };
}

async function runVaultCheck(home?: string): Promise<ObsidianConfigCliResult> {
  let connector;
  try {
    connector = await createObsidianConnectorFromDisk(
      home !== undefined ? { home, log: cliLog } : { log: cliLog },
    );
  } catch (err) {
    if (err instanceof ObsidianConfigError) {
      console.error(`[symphony] obsidian: ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
  if (connector === undefined) {
    console.error(
      '[symphony] obsidian: not configured (missing obsidian.json). ' +
        'Run `symphony config obsidian --vault <path>` first.',
    );
    return { exitCode: 1 };
  }
  try {
    const check = await connector.checkVault();
    if (!check.ok) {
      console.error(`[symphony] obsidian: vault check failed: ${check.reason}`);
      return { exitCode: 1 };
    }
    console.log('[symphony] obsidian: vault OK.');
    console.log(`  markdown files: ${check.fileCount ?? 0}`);
    console.log(`  open tasks found: ${check.openTaskCount ?? 0}`);
    return { exitCode: 0 };
  } catch (err) {
    const detail = err instanceof ObsidianError || err instanceof Error ? err.message : String(err);
    console.error(`[symphony] obsidian: vault check failed: ${detail}`);
    return { exitCode: 1 };
  }
}

function cliLog(level: 'info' | 'warn' | 'error', message: string): void {
  if (level === 'error') console.error(`[symphony] obsidian: ${message}`);
  else if (level === 'warn') console.warn(`[symphony] obsidian: ${message}`);
}
