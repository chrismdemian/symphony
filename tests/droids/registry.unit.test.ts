import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadProjectDroids, droidsDirFor } from '../../src/droids/registry.js';

let project: string;
let droidsDir: string;

beforeEach(() => {
  project = mkdtempSync(path.join(tmpdir(), 'sym-4f1-reg-'));
  droidsDir = droidsDirFor(project);
});
afterEach(() => {
  try {
    rmSync(project, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeDroid(name: string, body: string): void {
  mkdirSync(droidsDir, { recursive: true });
  writeFileSync(path.join(droidsDir, `${name}.md`), body);
}

const ok = (name: string) =>
  `---\nname: ${name}\ntools_denied: [bash]\n---\nYou are ${name}.`;

describe('loadProjectDroids', () => {
  it('missing .symphony/droids dir ⇒ empty, no warnings (the common case)', async () => {
    const r = await loadProjectDroids(project);
    expect(r.droids.size).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it('loads valid droids keyed by name', async () => {
    writeDroid('dhh-reviewer', ok('dhh-reviewer'));
    writeDroid('design-researcher', ok('design-researcher'));
    const r = await loadProjectDroids(project);
    expect([...r.droids.keys()].sort()).toEqual([
      'design-researcher',
      'dhh-reviewer',
    ]);
    expect(r.droids.get('dhh-reviewer')!.toolsDenied).toEqual(['bash']);
  });

  it('a malformed droid is a warning, not a throw; valid siblings still load', async () => {
    writeDroid('good', ok('good'));
    writeDroid('bad', '---\nname: bad\nbogus: 1\n---\nbody'); // unknown key
    const r = await loadProjectDroids(project);
    expect(r.droids.has('good')).toBe(true);
    expect(r.droids.has('bad')).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.source).toMatch(/bad\.md$/);
    expect(r.warnings[0]!.message).toMatch(/unknown frontmatter key/);
  });

  it('name not matching filename stem is a warning', async () => {
    writeDroid('alpha', ok('beta'));
    const r = await loadProjectDroids(project);
    expect(r.droids.size).toBe(0);
    expect(r.warnings[0]!.message).toMatch(/does not match expected/);
  });

  it('non-.md files and subdirectories are ignored', async () => {
    mkdirSync(droidsDir, { recursive: true });
    writeFileSync(path.join(droidsDir, 'README.txt'), 'not a droid');
    mkdirSync(path.join(droidsDir, 'nested'), { recursive: true });
    writeDroid('real', ok('real'));
    const r = await loadProjectDroids(project);
    expect([...r.droids.keys()]).toEqual(['real']);
    expect(r.warnings).toEqual([]);
  });
});
