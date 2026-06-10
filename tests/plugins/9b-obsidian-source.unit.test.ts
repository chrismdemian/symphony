/**
 * Phase 9B — unit coverage for the REAL obsidian-source plugin port
 * (`packages/examples/obsidian-source/src/{parser,obsidian}.ts`). The parser
 * runs directly; `ObsidianSource` runs over an in-memory vault so the
 * scan→map and the byte-preserving checkbox writeback (frontmatter-skip,
 * ordinal disambiguation, locator drift) are exercised faithfully.
 */
import { describe, expect, it } from 'vitest';

import {
  parseTasksFromBody,
  bodyStartLine,
  rewriteTaskLineStatus,
} from '../../packages/examples/obsidian-source/src/parser.js';
import { ObsidianSource } from '../../packages/examples/obsidian-source/src/obsidian.js';
import { ObsidianSourceConfigSchema } from '../../packages/examples/obsidian-source/src/config.js';
import type { VaultFsLike } from '../../packages/examples/obsidian-source/src/vault.js';

function memVault(files: Record<string, string>): VaultFsLike & { files: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    root: '/vault',
    files: store,
    async listMarkdownFiles() {
      return Object.keys(store).sort();
    },
    async readFile(rel) {
      const c = store[rel];
      if (c === undefined) throw new Error(`ENOENT: ${rel}`);
      return c;
    },
    async writeFile(rel, content) {
      store[rel] = content;
    },
    async isVault() {
      return true;
    },
  };
}

const config = (overrides: Record<string, unknown> = {}) =>
  ObsidianSourceConfigSchema.parse({ vaultPath: '/vault', ...overrides });
const FIXED_NOW = () => Date.parse('2026-06-09T12:00:00Z');

describe('9B obsidian-source — parser', () => {
  it('parses open + terminal tasks and classifies them', () => {
    const body = ['- [ ] Open task', '- [x] Done task', '- [-] Cancelled task', '- [/] Doing'].join('\n');
    const tasks = parseTasksFromBody(body);
    expect(tasks.map((t) => [t.description, t.status, t.terminal])).toEqual([
      ['Open task', 'pending', false],
      ['Done task', 'completed', true],
      ['Cancelled task', 'cancelled', true],
      ['Doing', 'in_progress', false],
    ]);
  });

  it('locator precedence: 🆔 id → ^block → content hash', () => {
    const tasks = parseTasksFromBody(
      ['- [ ] With id 🆔 abc123', '- [ ] With block ^blk-1', '- [ ] Plain hashed'].join('\n'),
    );
    expect(tasks[0]!.locator).toBe('id:abc123');
    expect(tasks[1]!.locator).toBe('^blk-1');
    expect(tasks[2]!.locator).toMatch(/^h:[0-9a-f]{16}$/);
  });

  it('disambiguates identical task lines with a within-file ordinal', () => {
    const tasks = parseTasksFromBody(['- [ ] Reply to Bob', '- [ ] Reply to Bob'].join('\n'));
    expect(tasks[0]!.locator).toMatch(/^h:[0-9a-f]{16}$/);
    expect(tasks[1]!.locator).toBe(`${tasks[0]!.locator}:2`);
  });

  it('skips tasks inside fenced code blocks', () => {
    const body = ['- [ ] Real', '```', '- [ ] In a fence', '```', '- [ ] Also real'].join('\n');
    expect(parseTasksFromBody(body).map((t) => t.description)).toEqual(['Real', 'Also real']);
  });

  it('bodyStartLine finds the line after frontmatter', () => {
    expect(bodyStartLine(['---', 'project: x', '---', '- [ ] task'])).toBe(3);
    expect(bodyStartLine(['# no frontmatter', '- [ ] task'])).toBe(0);
  });

  it('rewriteTaskLineStatus flips the char and stamps a done date', () => {
    expect(rewriteTaskLineStatus('- [ ] Task', 'x', { doneDate: '2026-06-09' })).toBe('- [x] Task ✅ 2026-06-09');
    expect(rewriteTaskLineStatus('  - [ ] Indented', 'x')).toBe('  - [x] Indented');
    expect(rewriteTaskLineStatus('- [x] Already done', 'x')).toBeUndefined();
  });
});

describe('9B obsidian-source — ObsidianSource over an in-memory vault', () => {
  it('maps vault tasks to issues with frontmatter project + isTerminal', async () => {
    const vault = memVault({
      'notes/todo.md': ['---', 'project: acme/widgets', '---', '- [ ] Build it 🔼', '- [x] Old'].join('\n'),
    });
    const issues = await new ObsidianSource(config(), { vault }).fetchOpenIssues();
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      title: 'Build it',
      projectValue: 'acme/widgets',
      isTerminal: false,
      priority: 1,
    });
    expect(issues[0]!.externalId).toMatch(/^notes\/todo\.md#h:[0-9a-f]{16}$/);
    expect(issues[1]!.isTerminal).toBe(true);
  });

  it('writeback flips the checkbox byte-preservingly + stamps the done date', async () => {
    const vault = memVault({
      'notes/todo.md': ['# Notes', '- [ ] First task', '- [ ] Second task'].join('\n'),
    });
    const src = new ObsidianSource(config(), { vault, now: FIXED_NOW });
    const issues = await src.fetchOpenIssues();
    const second = issues.find((i) => i.title === 'Second task')!;
    const result = await src.writeBack(second.externalId, 'completed');
    expect(result).toEqual({ written: true, code: 'written', value: 'x' });
    // Only the second line changed; the first is byte-identical.
    expect(vault.files['notes/todo.md']).toBe(
      ['# Notes', '- [ ] First task', '- [x] Second task ✅ 2026-06-09'].join('\n'),
    );
  });

  it('writeback preserves CRLF terminators on untouched lines', async () => {
    const vault = memVault({ 'a.md': '- [ ] one\r\n- [ ] two\r\n' });
    const src = new ObsidianSource(config({ statusWriteback: { completed: 'x', appendDoneDate: false } }), {
      vault,
      now: FIXED_NOW,
    });
    const issues = await src.fetchOpenIssues();
    const one = issues.find((i) => i.title === 'one')!;
    await src.writeBack(one.externalId, 'completed');
    expect(vault.files['a.md']).toBe('- [x] one\r\n- [ ] two\r\n');
  });

  it('never matches a [ ]-shaped line inside frontmatter', async () => {
    const vault = memVault({
      'a.md': ['---', 'note: "- [ ] not a task"', '---', '- [ ] real task'].join('\n'),
    });
    const src = new ObsidianSource(config(), { vault, now: FIXED_NOW });
    const issues = await src.fetchOpenIssues();
    expect(issues).toHaveLength(1);
    await src.writeBack(issues[0]!.externalId, 'completed');
    // The frontmatter line is untouched; only the real task flipped.
    expect(vault.files['a.md']).toContain('note: "- [ ] not a task"');
    expect(vault.files['a.md']).toContain('- [x] real task');
  });

  it('writeback on a drifted locator → not-found', async () => {
    const vault = memVault({ 'a.md': '- [ ] task' });
    const src = new ObsidianSource(config(), { vault });
    const result = await src.writeBack('a.md#h:deadbeefdeadbeef', 'completed');
    expect(result.code).toBe('not-found');
  });

  it('writeback failed → skipped when no failed char configured', async () => {
    const vault = memVault({ 'a.md': '- [ ] task' });
    const src = new ObsidianSource(config(), { vault });
    const issues = await src.fetchOpenIssues();
    const result = await src.writeBack(issues[0]!.externalId, 'failed');
    expect(result.code).toBe('skipped');
  });
});
