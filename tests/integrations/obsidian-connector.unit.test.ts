import { describe, expect, it } from 'vitest';
import {
  ObsidianConnector,
  type ObsidianConnectorDeps,
} from '../../src/integrations/obsidian.js';
import {
  defaultObsidianConfig,
  type ObsidianConfig,
} from '../../src/integrations/obsidian-config.js';
import type { VaultFsLike } from '../../src/integrations/obsidian-vault.js';

/** An in-memory `VaultFsLike` for deterministic connector tests. */
function fakeVault(files: Record<string, string>, root = '/vault'): {
  vault: VaultFsLike;
  files: Record<string, string>;
  writes: { relPath: string; content: string }[];
} {
  const store = { ...files };
  const writes: { relPath: string; content: string }[] = [];
  const vault: VaultFsLike = {
    root,
    listMarkdownFiles: async () =>
      Object.keys(store)
        .filter((p) => p.toLowerCase().endsWith('.md'))
        .sort(),
    readFile: async (rel) => {
      if (!(rel in store)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return store[rel] as string;
    },
    writeFile: async (rel, content) => {
      store[rel] = content;
      writes.push({ relPath: rel, content });
    },
    isVault: async () => true,
  };
  return { vault, files: store, writes };
}

function connector(
  files: Record<string, string>,
  config: ObsidianConfig = defaultObsidianConfig('/vault'),
  extra: Partial<ObsidianConnectorDeps> = {},
) {
  const fv = fakeVault(files, config.vaultPath);
  const conn = new ObsidianConnector({ vault: fv.vault, config, ...extra });
  return { conn, ...fv };
}

describe('ObsidianConnector.fetchOpenTasks', () => {
  it('maps ALL task lines to candidates (ingest filters terminal, not the connector)', async () => {
    const { conn } = connector({
      'tasks.md': [
        '---',
        'project: symphony',
        '---',
        '- [ ] Open task ⏫',
        '- [x] Already done',
        '- [-] Cancelled',
        '- [/] In progress',
      ].join('\n'),
    });
    const out = await conn.fetchOpenTasks();
    expect(out.map((c) => c.title)).toEqual([
      'Open task',
      'Already done',
      'Cancelled',
      'In progress',
    ]);
    expect(out.map((c) => c.status)).toEqual([
      'pending',
      'completed',
      'cancelled',
      'in_progress',
    ]);
    const open = out[0];
    expect(open?.priority).toBe(2);
    expect(open?.projectValue).toBe('symphony');
    expect(open?.externalId.startsWith('tasks.md#')).toBe(true);
    expect(open?.url).toContain('obsidian://open?vault=vault');
  });

  it('returns null project value when frontmatter has no project key', async () => {
    const { conn } = connector({ 'a.md': '- [ ] No frontmatter task' });
    const [c] = await conn.fetchOpenTasks();
    expect(c?.projectValue).toBeNull();
  });

  it('honors a custom projectProperty', async () => {
    const cfg = { ...defaultObsidianConfig('/vault'), projectProperty: 'route' };
    const { conn } = connector(
      { 'a.md': ['---', 'route: alpha', '---', '- [ ] Task'].join('\n') },
      cfg,
    );
    const [c] = await conn.fetchOpenTasks();
    expect(c?.projectValue).toBe('alpha');
  });

  it('respects the limit across files', async () => {
    const { conn } = connector({
      'a.md': '- [ ] one\n- [ ] two',
      'b.md': '- [ ] three',
    });
    const out = await conn.fetchOpenTasks({ limit: 2 });
    expect(out).toHaveLength(2);
  });

  it('skips tasks inside fenced code blocks', async () => {
    const { conn } = connector({
      'a.md': ['- [ ] real', '```', '- [ ] fenced', '```'].join('\n'),
    });
    const out = await conn.fetchOpenTasks();
    expect(out.map((c) => c.title)).toEqual(['real']);
  });
});

describe('ObsidianConnector.writeBackStatus', () => {
  it('flips the matching task line to done and stamps the date', async () => {
    const { conn, files } = connector(
      { 'tasks.md': ['- [ ] First task', '- [ ] Second task'].join('\n') },
      defaultObsidianConfig('/vault'),
      { now: () => Date.parse('2026-06-10T12:00:00Z') },
    );
    const [first] = await conn.fetchOpenTasks();
    const result = await conn.writeBackStatus(first?.externalId ?? '', 'completed');
    expect(result.written).toBe(true);
    expect(result.value).toBe('x');
    expect(files['tasks.md']).toContain('- [x] First task ✅ 2026-06-10');
    // The second task is untouched.
    expect(files['tasks.md']).toContain('- [ ] Second task');
  });

  it('locates the right line even after the file shifted around it', async () => {
    const { conn, files } = connector({
      'tasks.md': ['- [ ] Target task'].join('\n'),
    });
    const [target] = await conn.fetchOpenTasks();
    // Simulate the user adding lines ABOVE the task in Obsidian before completion.
    files['tasks.md'] = ['# New heading', '', 'some prose', '- [ ] Target task'].join('\n');
    const result = await conn.writeBackStatus(target?.externalId ?? '', 'completed');
    expect(result.written).toBe(true);
    expect(files['tasks.md']).toContain('- [x] Target task');
    expect(files['tasks.md']).toContain('# New heading');
  });

  it('does not write back failed when no failed char is configured', async () => {
    const { conn, writes } = connector({ 'a.md': '- [ ] Task' });
    const [c] = await conn.fetchOpenTasks();
    const result = await conn.writeBackStatus(c?.externalId ?? '', 'failed');
    expect(result.written).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('writes back failed with a configured char', async () => {
    const cfg: ObsidianConfig = {
      ...defaultObsidianConfig('/vault'),
      statusWriteback: { completed: 'x', failed: '-', appendDoneDate: true },
    };
    const { conn, files } = connector({ 'a.md': '- [ ] Task' }, cfg);
    const [c] = await conn.fetchOpenTasks();
    const result = await conn.writeBackStatus(c?.externalId ?? '', 'failed');
    expect(result.written).toBe(true);
    expect(result.value).toBe('-');
    expect(files['a.md']).toContain('- [-] Task');
  });

  it('reports line-not-found when the task was deleted from the vault', async () => {
    const { conn, files } = connector({ 'a.md': '- [ ] Task' });
    const [c] = await conn.fetchOpenTasks();
    files['a.md'] = '- [ ] A totally different task';
    const result = await conn.writeBackStatus(c?.externalId ?? '', 'completed');
    expect(result.written).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('reports a malformed external id', async () => {
    const { conn } = connector({ 'a.md': '- [ ] Task' });
    const result = await conn.writeBackStatus('no-hash-here', 'completed');
    expect(result.written).toBe(false);
    expect(result.reason).toContain('malformed');
  });

  it('is an idempotent no-op when the line is already at the target', async () => {
    const cfg: ObsidianConfig = {
      ...defaultObsidianConfig('/vault'),
      statusWriteback: { completed: 'x', appendDoneDate: false },
    };
    const { conn, writes } = connector({ 'a.md': '- [ ] Task' }, cfg);
    const [c] = await conn.fetchOpenTasks();
    await conn.writeBackStatus(c?.externalId ?? '', 'completed'); // flips to x
    writes.length = 0;
    const again = await conn.writeBackStatus(c?.externalId ?? '', 'completed');
    expect(again.written).toBe(false);
    expect(writes).toHaveLength(0);
  });
});

describe('ObsidianConnector.checkVault', () => {
  it('reports file + open-task counts for a healthy vault', async () => {
    const { conn } = connector({
      'a.md': '- [ ] one\n- [x] done',
      'b.md': '- [ ] two',
      'notes.txt': 'ignored',
    });
    const check = await conn.checkVault();
    expect(check.ok).toBe(true);
    expect(check.fileCount).toBe(2); // .md only
    expect(check.openTaskCount).toBe(2); // done is skipped
  });
});
