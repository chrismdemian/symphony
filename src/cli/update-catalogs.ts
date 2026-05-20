import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { symphonyDataDir } from '../utils/config.js';

/**
 * Phase 4F.2 — `symphony update-catalogs`.
 *
 * Vendors the awesome-design-md design catalog (VoltAgent, MIT) into
 * `~/.symphony/design-catalog/<slug>.md` for the bundled
 * `design-researcher` droid to consume offline. The droid prompt
 * (`src/droids/bundled/design-researcher.md`) references the vendor
 * dir via the `{design_catalog_dir}` system var, substituted at
 * server-boot time (`loadBundledDroids` → `applySystemVars`).
 *
 * Fetch mechanism: VoltAgent's own `getdesign` npm CLI (`npx -y
 * getdesign@latest list` for the slug index; `npx -y
 * getdesign@latest add <slug> --out <abs>` to write one DESIGN.md).
 * `getdesign.md` itself serves only an HTML SPA (probed; no raw
 * markdown endpoint at `/raw` or `.md`), so the CLI is the
 * upstream-maintained machine interface.
 *
 * `runNpx`/`logger` are dependency-injection seams for tests; defaults
 * spawn real `npx` and write to `process.stdout`/`stderr`.
 */

export interface NpxRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type NpxRunner = (
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<NpxRunResult>;

export interface UpdateCatalogsLogger {
  info(line: string): void;
  warn(line: string): void;
}

export interface RunUpdateCatalogsOptions {
  /** Skip-if-exists by default; pass `force` to refetch every slug. */
  readonly force?: boolean;
  /**
   * Only update this single slug (matches the `getdesign list` slug).
   * Useful for testing or fixing one stale entry.
   */
  readonly only?: string;
  /** Override the vendor dir (default `~/.symphony/design-catalog/`). */
  readonly vendorDir?: string;
  readonly runNpx?: NpxRunner;
  readonly logger?: UpdateCatalogsLogger;
}

export interface UpdateCatalogsResult {
  readonly vendorDir: string;
  readonly installed: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly { slug: string; error: string }[];
  readonly exitCode: number;
}

const DEFAULT_NPX_PACKAGE = 'getdesign@latest';

const defaultLogger: UpdateCatalogsLogger = {
  info: (l) => process.stdout.write(`${l}\n`),
  warn: (l) => process.stderr.write(`${l}\n`),
};

const defaultNpx: NpxRunner = (args, options) =>
  new Promise((resolve) => {
    const child = spawn('npx', args as string[], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      // Shell-form on Windows: `npx` resolves via PATHEXT to `npx.cmd`,
      // which Node refuses to spawn in exec-form (the known Win32
      // `.cmd` shim gotcha from 1B). Shell-form delegates to cmd.exe
      // / the user's shell, which handles `.cmd` correctly.
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += String(c)));
    child.stderr?.on('data', (c) => (stderr += String(c)));
    child.on('error', (err) => {
      resolve({ exitCode: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });

/**
 * Parse `getdesign list` output: each line is `slug - description.`
 * (slug = lowercase, may contain `.`, `-`). Banner ANSI lines + blank
 * lines are dropped.
 */
export function parseSlugList(stdoutRaw: string): Array<{ slug: string; description: string }> {
  // Strip ANSI escapes the CLI banner emits.
  // eslint-disable-next-line no-control-regex
  const noAnsi = stdoutRaw.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  const out: Array<{ slug: string; description: string }> = [];
  for (const line of noAnsi.split(/\r?\n/)) {
    const m = /^([a-z0-9][a-z0-9.-]*) - (.+)$/.exec(line.trim());
    if (m !== null) out.push({ slug: m[1]!, description: m[2]! });
  }
  return out;
}

export async function runUpdateCatalogs(
  options: RunUpdateCatalogsOptions = {},
): Promise<UpdateCatalogsResult> {
  const vendorDir =
    options.vendorDir ?? path.join(symphonyDataDir(), 'design-catalog');
  const runNpx = options.runNpx ?? defaultNpx;
  const logger = options.logger ?? defaultLogger;
  const force = options.force === true;

  await fsp.mkdir(vendorDir, { recursive: true });

  logger.info(`[symphony] fetching slug index via 'getdesign list'…`);
  const listResult = await runNpx(['-y', DEFAULT_NPX_PACKAGE, 'list'], {});
  if (listResult.exitCode !== 0) {
    logger.warn(
      `[symphony] 'getdesign list' failed (exit ${listResult.exitCode}). ` +
        `stderr: ${listResult.stderr.slice(0, 500)}`,
    );
    return {
      vendorDir,
      installed: [],
      skipped: [],
      failed: [],
      exitCode: 1,
    };
  }
  const slugs = parseSlugList(listResult.stdout);
  if (slugs.length === 0) {
    logger.warn(
      "[symphony] 'getdesign list' returned no parseable slugs. " +
        `Output sample: ${listResult.stdout.slice(0, 200)}`,
    );
    return { vendorDir, installed: [], skipped: [], failed: [], exitCode: 1 };
  }
  logger.info(`[symphony] ${slugs.length} design system(s) listed by getdesign.`);

  // Write a vendor README index so the design-researcher droid can read
  // categorized one-liners without re-running `getdesign list`.
  const readmePath = path.join(vendorDir, 'README.md');
  const readmeBody =
    '# Symphony design-catalog index\n\n' +
    'Vendored from `getdesign list` (VoltAgent/awesome-design-md, MIT). ' +
    "Refresh via `symphony update-catalogs`.\n\n" +
    slugs.map((s) => `- **${s.slug}** — ${s.description}`).join('\n') +
    '\n';
  await fsp.writeFile(readmePath, readmeBody, 'utf8');

  const targets =
    options.only !== undefined
      ? slugs.filter((s) => s.slug === options.only)
      : slugs;
  if (options.only !== undefined && targets.length === 0) {
    logger.warn(
      `[symphony] --slug '${options.only}' not found in 'getdesign list' output.`,
    );
    return { vendorDir, installed: [], skipped: [], failed: [], exitCode: 1 };
  }

  const installed: string[] = [];
  const skipped: string[] = [];
  const failed: { slug: string; error: string }[] = [];

  for (const { slug } of targets) {
    const dest = path.join(vendorDir, `${slug}.md`);
    if (!force) {
      try {
        await fsp.access(dest);
        skipped.push(slug);
        logger.info(`[symphony] ${slug}: skipped (already present; --force to refetch)`);
        continue;
      } catch {
        /* not present — fall through to fetch */
      }
    }
    const addResult = await runNpx(
      ['-y', DEFAULT_NPX_PACKAGE, 'add', slug, '--out', dest, '--force'],
      {},
    );
    if (addResult.exitCode === 0) {
      // Confirm the file was actually written (a CLI exit-0 + missing
      // file would be a silent failure we must not mask).
      try {
        await fsp.access(dest);
      } catch {
        const error = `getdesign add ${slug} exited 0 but no file at ${dest}`;
        failed.push({ slug, error });
        logger.warn(`[symphony] ${slug}: FAIL — ${error}`);
        continue;
      }
      installed.push(slug);
      logger.info(`[symphony] ${slug}: installed → ${dest}`);
    } else {
      const error =
        `getdesign add ${slug} exited ${addResult.exitCode}` +
        (addResult.stderr.trim().length > 0
          ? ` — ${addResult.stderr.slice(0, 200)}`
          : '');
      failed.push({ slug, error });
      logger.warn(`[symphony] ${slug}: FAIL — ${error}`);
    }
  }

  logger.info(
    `[symphony] update-catalogs done — ${installed.length} installed, ${skipped.length} skipped, ${failed.length} failed. Vendor dir: ${vendorDir}`,
  );

  return {
    vendorDir,
    installed,
    skipped,
    failed,
    exitCode: failed.length > 0 ? 2 : 0,
  };
}
