import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runObsidianConfig } from '../../src/cli/obsidian-config.js';
import { loadObsidianConfig } from '../../src/integrations/obsidian-config.js';

describe('runObsidianConfig', () => {
  let home: string;
  let vault: string;
  let logs: string[];
  let errs: string[];

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-obs-home-'));
    vault = mkdtempSync(path.join(tmpdir(), 'symphony-obs-vault-'));
    logs = [];
    errs = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => {
      errs.push(String(m));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
  });

  it('writes config for --vault and persists an absolute path', async () => {
    const res = await runObsidianConfig({ vault, taskFormat: 'emoji', home });
    expect(res.exitCode).toBe(0);
    const cfg = await loadObsidianConfig(home);
    expect(cfg?.vaultPath).toBe(path.resolve(vault));
    expect(cfg?.taskFormat).toBe('emoji');
  });

  it('rejects an invalid --task-format', async () => {
    const res = await runObsidianConfig({ vault, taskFormat: 'bogus', home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('invalid --task-format');
  });

  it('--no-watch persists watch=false', async () => {
    await runObsidianConfig({ vault, home });
    await runObsidianConfig({ watch: false, home });
    expect((await loadObsidianConfig(home))?.watch).toBe(false);
  });

  it('shows "not configured" when nothing is set and no config exists', async () => {
    const res = await runObsidianConfig({ home });
    expect(res.exitCode).toBe(0);
    expect(logs.join('\n')).toContain('not configured');
  });

  it('--status reports vault OK with file + open-task counts', async () => {
    writeFileSync(
      path.join(vault, 'a.md'),
      ['- [ ] open one', '- [x] done', '- [ ] open two'].join('\n'),
      'utf8',
    );
    await runObsidianConfig({ vault, home });
    logs.length = 0;
    const res = await runObsidianConfig({ check: true, home });
    expect(res.exitCode).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('vault OK');
    expect(out).toContain('markdown files: 1');
    expect(out).toContain('open tasks found: 2');
  });

  it('--status fails when the configured vault path is not a directory', async () => {
    await runObsidianConfig({ vault: path.join(vault, 'does-not-exist'), home });
    const res = await runObsidianConfig({ check: true, home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('vault check failed');
  });

  it('--status fails cleanly when Obsidian is unconfigured', async () => {
    const res = await runObsidianConfig({ check: true, home });
    expect(res.exitCode).toBe(1);
    expect(errs.join('\n')).toContain('not configured');
  });
});
