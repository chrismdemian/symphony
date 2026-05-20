import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseSlugList,
  quoteWinShellArg,
  runUpdateCatalogs,
  type NpxRunner,
  type NpxRunResult,
} from '../../src/cli/update-catalogs.js';

let vendorDir: string;
const silentLogger = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  vendorDir = mkdtempSync(path.join(tmpdir(), 'sym-4f2-uc-'));
  silentLogger.info.mockReset();
  silentLogger.warn.mockReset();
});
afterEach(() => {
  try {
    rmSync(vendorDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// 4F.2 audit M1 — Win32 cmd.exe argv quoting. `shell:true` concatenates
// args without quoting (Node DEP0190), so paths-with-spaces silently
// break. This helper is the per-arg quoter the spawn path uses on Win32.
describe('quoteWinShellArg', () => {
  it('returns simple alphanumeric args unchanged', () => {
    expect(quoteWinShellArg('npx')).toBe('npx');
    expect(quoteWinShellArg('add')).toBe('add');
    expect(quoteWinShellArg('raycast')).toBe('raycast');
    expect(quoteWinShellArg('--force')).toBe('--force');
  });

  it('wraps args with spaces in double quotes', () => {
    expect(quoteWinShellArg('C:\\Users\\Display Name\\x.md')).toBe(
      '"C:\\Users\\Display Name\\x.md"',
    );
  });

  it('escapes embedded quotes (CreateProcess argv rules)', () => {
    expect(quoteWinShellArg('a "b" c')).toBe('"a \\"b\\" c"');
  });

  it('doubles backslashes that immediately precede a quote', () => {
    // `foo\"bar` → backslash is doubled when followed by a quote.
    expect(quoteWinShellArg('foo\\"bar')).toBe('"foo\\\\\\"bar"');
  });

  it('doubles trailing backslashes when arg ends in a backslash run', () => {
    // `C:\path\` → wrapped becomes `"C:\path\\"` (trailing \ doubled
    // because it would otherwise escape the closing quote).
    expect(quoteWinShellArg('C:\\path with space\\')).toBe(
      '"C:\\path with space\\\\"',
    );
  });

  it.each(['&', '|', '<', '>', '^', '(', ')', '%', '!'])(
    'wraps args containing cmd-metachar %s',
    (mc) => {
      const arg = `safe${mc}arg`;
      expect(quoteWinShellArg(arg)).toBe(`"${arg}"`);
    },
  );

  it('returns "" for an empty arg (cmd.exe requires explicit empty)', () => {
    expect(quoteWinShellArg('')).toBe('""');
  });
});

describe('parseSlugList', () => {
  it('parses lines of the form `slug - description.`', () => {
    const out = parseSlugList(
      'raycast - Productivity launcher.\nlinear.app - Dev workflow.\nx.ai - Stark monochrome.\n',
    );
    expect(out).toEqual([
      { slug: 'raycast', description: 'Productivity launcher.' },
      { slug: 'linear.app', description: 'Dev workflow.' },
      { slug: 'x.ai', description: 'Stark monochrome.' },
    ]);
  });

  it('strips ANSI escape sequences from the banner', () => {
    const banner = '\x1b[97m███\x1b[0m getdesign\n';
    const out = parseSlugList(`${banner}raycast - Productivity launcher.\n`);
    expect(out).toEqual([{ slug: 'raycast', description: 'Productivity launcher.' }]);
  });

  it('drops malformed and blank lines', () => {
    const out = parseSlugList(
      '\n\n   \nSome banner without dash\nraycast - desc.\nCAPSLOCK - desc.\n',
    );
    // Slugs are lowercase per the regex; CAPSLOCK is rejected.
    expect(out).toEqual([{ slug: 'raycast', description: 'desc.' }]);
  });
});

function makeNpx(opts: {
  listStdout?: string;
  listExit?: number;
  addExit?: (slug: string) => number;
  addFails?: ReadonlySet<string>;
  writeFile?: boolean;
}): NpxRunner {
  return async (args, _options): Promise<NpxRunResult> => {
    // First positional after `-y getdesign@latest` is the subcommand.
    const sub = args[2];
    if (sub === 'list') {
      return {
        exitCode: opts.listExit ?? 0,
        stdout: opts.listStdout ?? 'raycast - Productivity launcher.\nlinear.app - Dev workflow.\n',
        stderr: '',
      };
    }
    if (sub === 'add') {
      const slug = args[3] ?? '';
      const outIdx = args.indexOf('--out');
      const outPath = outIdx > 0 ? args[outIdx + 1] : undefined;
      const exit =
        opts.addExit?.(slug) ??
        (opts.addFails?.has(slug) === true ? 1 : 0);
      if (exit === 0 && opts.writeFile !== false && outPath !== undefined) {
        writeFileSync(outPath, `# DESIGN.md for ${slug}\n`);
      }
      return { exitCode: exit, stdout: '', stderr: exit !== 0 ? `failed ${slug}` : '' };
    }
    return { exitCode: 1, stdout: '', stderr: `unknown sub ${sub}` };
  };
}

describe('runUpdateCatalogs', () => {
  it('writes README index + installs every listed slug', async () => {
    const r = await runUpdateCatalogs({
      vendorDir,
      runNpx: makeNpx({}),
      logger: silentLogger,
    });
    expect(r.exitCode).toBe(0);
    expect(r.installed).toEqual(['raycast', 'linear.app']);
    expect(r.skipped).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(existsSync(path.join(vendorDir, 'raycast.md'))).toBe(true);
    expect(existsSync(path.join(vendorDir, 'linear.app.md'))).toBe(true);
    const readme = readFileSync(path.join(vendorDir, 'README.md'), 'utf8');
    expect(readme).toContain('**raycast**');
    expect(readme).toContain('**linear.app**');
  });

  it('skips slugs already present (idempotent)', async () => {
    writeFileSync(path.join(vendorDir, 'raycast.md'), 'already here');
    const r = await runUpdateCatalogs({
      vendorDir,
      runNpx: makeNpx({}),
      logger: silentLogger,
    });
    expect(r.skipped).toContain('raycast');
    expect(r.installed).toContain('linear.app');
    // Existing file is left untouched.
    expect(readFileSync(path.join(vendorDir, 'raycast.md'), 'utf8')).toBe(
      'already here',
    );
  });

  it('force refetches every slug', async () => {
    writeFileSync(path.join(vendorDir, 'raycast.md'), 'stale');
    const r = await runUpdateCatalogs({
      vendorDir,
      force: true,
      runNpx: makeNpx({}),
      logger: silentLogger,
    });
    expect(r.skipped).toEqual([]);
    expect(r.installed).toEqual(['raycast', 'linear.app']);
    expect(readFileSync(path.join(vendorDir, 'raycast.md'), 'utf8')).toContain(
      'DESIGN.md for raycast',
    );
  });

  it('--only filters to one slug; unknown --only is exitCode 1', async () => {
    const r = await runUpdateCatalogs({
      vendorDir,
      only: 'raycast',
      runNpx: makeNpx({}),
      logger: silentLogger,
    });
    expect(r.installed).toEqual(['raycast']);
    expect(existsSync(path.join(vendorDir, 'linear.app.md'))).toBe(false);

    const bad = await runUpdateCatalogs({
      vendorDir,
      only: 'nonexistent',
      runNpx: makeNpx({}),
      logger: silentLogger,
    });
    expect(bad.exitCode).toBe(1);
  });

  it('per-slug failures are tolerated; valid slugs still install', async () => {
    const r = await runUpdateCatalogs({
      vendorDir,
      runNpx: makeNpx({ addFails: new Set(['raycast']) }),
      logger: silentLogger,
    });
    expect(r.installed).toEqual(['linear.app']);
    expect(r.failed.map((f) => f.slug)).toEqual(['raycast']);
    expect(r.exitCode).toBe(2);
  });

  it('catches the silent-failure case: npx exit 0 but no file written', async () => {
    const r = await runUpdateCatalogs({
      vendorDir,
      runNpx: makeNpx({ writeFile: false }),
      logger: silentLogger,
    });
    expect(r.installed).toEqual([]);
    expect(r.failed).toHaveLength(2);
    expect(r.failed[0]!.error).toMatch(/exited 0 but no file/);
    expect(r.exitCode).toBe(2);
  });

  it("aborts with exitCode 1 when `getdesign list` itself fails", async () => {
    const r = await runUpdateCatalogs({
      vendorDir,
      runNpx: makeNpx({ listExit: 1, listStdout: '' }),
      logger: silentLogger,
    });
    expect(r.exitCode).toBe(1);
    expect(r.installed).toEqual([]);
  });
});
