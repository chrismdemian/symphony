/**
 * Phase 3O.2 — PR content generator.
 *
 * Pure-function coverage (buildPrGenerationPrompt / normalizeMarkdown /
 * generateHeuristicContent / generateFallbackContent) is hermetic.
 * `generatePrContent`'s LLM → retry → heuristic → fallback decision logic
 * runs against a REAL temp git repo (exercising the git-ops range helpers +
 * getPrGitContext) with a FAKE one-shot runner — never spawns claude.
 */

import { execFileSync } from 'node:child_process';
import { promises as fsp, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPrGenerationPrompt,
  generateFallbackContent,
  generateHeuristicContent,
  generatePrContent,
  getPrGitContext,
  normalizeMarkdown,
  resolvePrBaseRef,
} from '../../src/orchestrator/pr-generation.js';
import type { OneShotResult, OneShotRunner } from '../../src/orchestrator/one-shot.js';

function fakeRunner(reply: string | (() => string | never)): OneShotRunner {
  return async (): Promise<OneShotResult> => {
    const text = typeof reply === 'function' ? reply() : reply;
    return {
      rawStdout: text,
      text,
      exitCode: 0,
      signaled: false,
      durationMs: 1,
      stderrTail: '',
    };
  };
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

/** Init a repo with a base branch + a feature branch carrying 2 changed files / 1 commit. */
function initRepoWithFeature(dir: string): { baseBranch: string } {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'init']);
  const baseBranch = git(dir, ['branch', '--show-current']);
  git(dir, ['checkout', '-q', '-b', 'feature/x']);
  writeFileSync(path.join(dir, 'a.txt'), 'hello\nworld\n');
  writeFileSync(path.join(dir, 'b.txt'), 'new file\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'feat: add world and b']);
  return { baseBranch };
}

describe('Phase 3O.2 — buildPrGenerationPrompt', () => {
  it('includes commits and a diff summary, demands JSON-only', () => {
    const prompt = buildPrGenerationPrompt('1 file changed', ['feat: a', 'fix: b']);
    expect(prompt).toContain('- feat: a');
    expect(prompt).toContain('- fix: b');
    expect(prompt).toContain('Diff summary:');
    expect(prompt).toContain('1 file changed');
    expect(prompt).toContain('ONLY valid JSON');
  });

  it('omits the commit/diff blocks when empty and caps the diff at 2000 chars', () => {
    const noContext = buildPrGenerationPrompt('', []);
    expect(noContext).not.toContain('Commits:');
    expect(noContext).not.toContain('Diff summary:');
    const big = 'x'.repeat(5000);
    const capped = buildPrGenerationPrompt(big, []);
    expect(capped).toContain('x'.repeat(2000) + '...');
    expect(capped).not.toContain('x'.repeat(2001));
  });
});

describe('Phase 3O.2 — normalizeMarkdown', () => {
  it('adds a blank line before headers, collapses 3+ blanks, trims trailing ws', () => {
    const out = normalizeMarkdown('Intro\n## A\nbody  \n\n\n\n## B   ');
    expect(out).toBe('Intro\n\n## A\nbody\n\n## B');
  });

  it('returns empty string unchanged', () => {
    expect(normalizeMarkdown('')).toBe('');
  });
});

describe('Phase 3O.2 — generateHeuristicContent', () => {
  it('derives the title from the first commit, re-adding its conventional prefix', () => {
    const c = generateHeuristicContent('2 files changed, 3 insertions(+)', ['feat: add login', 'wip'], [
      'src/login.ts',
      'src/auth.ts',
    ]);
    expect(c.title).toBe('feat: add login');
    expect(c.source).toBe('heuristic');
    expect(c.description).toContain('## Changes');
    expect(c.description).toContain('- feat: add login');
    expect(c.description).toContain('## Files Changed');
    expect(c.description).toContain('- `src/login.ts`');
  });

  it('truncates an over-72-char title', () => {
    const long = 'feat: ' + 'a'.repeat(100);
    const c = generateHeuristicContent('', [long], []);
    expect(c.title.length).toBeLessThanOrEqual(72);
    expect(c.title.startsWith('feat: ')).toBe(true);
  });

  it('infers a title from file patterns when there are no commits', () => {
    expect(generateHeuristicContent('', [], ['src/foo.test.ts']).title).toBe('test: add tests');
    expect(generateHeuristicContent('', [], ['src/bugfix.ts']).title).toBe('fix: resolve issue');
    expect(generateHeuristicContent('', [], ['Button.tsx']).title).toBe('feat: add Button');
    expect(generateHeuristicContent('', [], ['src/utils.ts']).title).toBe('chore: update utils');
  });

  it('renders a single-file summary inline with line stats', () => {
    const c = generateHeuristicContent('1 file changed, 5 insertions(+), 2 deletions(-)', [], [
      'src/only.ts',
    ]);
    expect(c.description).toContain('## Summary');
    expect(c.description).toContain('- Updated `src/only.ts`');
    expect(c.description).toContain('+5, -2 lines');
  });
});

describe('Phase 3O.2 — generateFallbackContent', () => {
  it('names the title after the first file when present', () => {
    const c = generateFallbackContent(['a/b/c.ts', 'd.ts']);
    expect(c.title).toBe('chore: update c.ts');
    expect(c.description).toBe('Updated 2 files.');
    expect(c.source).toBe('fallback');
  });

  it('falls back to a generic title with no files', () => {
    const c = generateFallbackContent([]);
    expect(c.title).toBe('chore: update code');
    expect(c.description).toBe('No changes detected.');
  });
});

describe('Phase 3O.2 — generatePrContent (real git + fake runner)', () => {
  let dir: string;
  let baseBranch: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sym-3o2-gen-'));
    baseBranch = initRepoWithFeature(dir).baseBranch;
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('getPrGitContext gathers the diffstat + commits + files against the base', async () => {
    const ctx = await getPrGitContext(dir, baseBranch);
    expect(ctx.baseRef).toBe(baseBranch);
    expect(ctx.commits).toContain('feat: add world and b');
    expect([...ctx.changedFiles].sort()).toEqual(['a.txt', 'b.txt']);
    expect(ctx.diff).toMatch(/files? changed/);
  });

  it('resolvePrBaseRef prefers the local base when origin is absent', async () => {
    expect(await resolvePrBaseRef(dir, baseBranch, 'origin')).toBe(baseBranch);
    expect(await resolvePrBaseRef(dir, 'does-not-exist', 'origin')).toBeNull();
  });

  it('uses the LLM result when it parses (source=llm)', async () => {
    const out = await generatePrContent(
      { worktreePath: dir, baseRef: baseBranch },
      { oneShotRunner: fakeRunner('{"title":"feat: world","description":"## What\\nAdded world."}') },
    );
    expect(out.source).toBe('llm');
    expect(out.title).toBe('feat: world');
    expect(out.description).toContain('## What');
    expect(out.description).toContain('Added world.');
  });

  it('retries once then falls back to heuristic when the LLM output never parses', async () => {
    let calls = 0;
    const runner: OneShotRunner = async () => {
      calls += 1;
      return {
        rawStdout: 'not json at all',
        text: 'not json at all',
        exitCode: 0,
        signaled: false,
        durationMs: 1,
        stderrTail: '',
      };
    };
    const out = await generatePrContent({ worktreePath: dir, baseRef: baseBranch }, { oneShotRunner: runner });
    expect(calls).toBe(2); // initial + one retry
    expect(out.source).toBe('heuristic');
    expect(out.title).toBe('feat: add world and b');
  });

  it('falls back to heuristic when the runner throws', async () => {
    const runner: OneShotRunner = async () => {
      throw new Error('claude blew up');
    };
    const out = await generatePrContent({ worktreePath: dir, baseRef: baseBranch }, { oneShotRunner: runner });
    expect(out.source).toBe('heuristic');
  });

  it('returns a bare fallback when there is no git context', async () => {
    // Diff against HEAD itself + clean tree → no commits, no diff.
    const out = await generatePrContent(
      { worktreePath: dir, baseRef: null },
      { oneShotRunner: fakeRunner('{"title":"x","description":"y"}') },
    );
    expect(out.source).toBe('fallback');
  });
});
