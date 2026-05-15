import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installSkill,
  installSkillFromPath,
  listSkills,
  uninstallSkill,
  SkillNotFoundError,
} from '../../src/skills/store.js';
import {
  assertSafeSkillId,
  SkillIdError,
  SYMPHONY_CLAUDE_COMMANDS_DIR_ENV,
  SYMPHONY_SKILLS_DIR_ENV,
  skillsDir,
  claudeCommandsDir,
} from '../../src/skills/paths.js';

let root: string;
let centralEnv: string | undefined;
let agentEnv: string | undefined;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'symphony-skills-'));
  centralEnv = process.env[SYMPHONY_SKILLS_DIR_ENV];
  agentEnv = process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV];
  process.env[SYMPHONY_SKILLS_DIR_ENV] = path.join(root, 'central');
  process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV] = path.join(root, 'agent');
});

afterEach(async () => {
  if (centralEnv === undefined) delete process.env[SYMPHONY_SKILLS_DIR_ENV];
  else process.env[SYMPHONY_SKILLS_DIR_ENV] = centralEnv;
  if (agentEnv === undefined) delete process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV];
  else process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV] = agentEnv;
  await fsp.rm(root, { recursive: true, force: true });
});

describe('assertSafeSkillId', () => {
  it('accepts a simple segment, rejects traversal/separators/dots/absolute', () => {
    expect(assertSafeSkillId(' dhh-reviewer ')).toBe('dhh-reviewer');
    for (const bad of ['..', '.', '.hidden', 'a/b', 'a\\b', '/abs', '']) {
      expect(() => assertSafeSkillId(bad)).toThrow(SkillIdError);
    }
  });
});

describe('installSkill', () => {
  it('writes central SKILL.md and an agent symlink resolving into central', async () => {
    const info = await installSkill({ id: 'rev', content: '# Reviewer\n' });
    expect(info).toMatchObject({ id: 'rev', linked: true });
    const manifest = path.join(skillsDir(), 'rev', 'SKILL.md');
    expect(await fsp.readFile(manifest, 'utf8')).toBe('# Reviewer\n');

    const link = path.join(claudeCommandsDir(), 'rev');
    const st = await fsp.lstat(link);
    expect(st.isSymbolicLink()).toBe(true);
    const resolved = path.resolve(
      path.dirname(link),
      await fsp.readlink(link),
    );
    expect(resolved).toBe(path.join(skillsDir(), 'rev'));
  });

  it('re-install replaces content atomically (no .tmp- leftovers)', async () => {
    await installSkill({ id: 'rev', content: 'v1' });
    await installSkill({ id: 'rev', content: 'v2' });
    expect(
      await fsp.readFile(path.join(skillsDir(), 'rev', 'SKILL.md'), 'utf8'),
    ).toBe('v2');
    const leftovers = (await fsp.readdir(skillsDir())).filter((n) =>
      n.includes('.tmp-'),
    );
    expect(leftovers).toEqual([]);
  });

  it('rejects an unsafe id before touching the filesystem', async () => {
    await expect(
      installSkill({ id: '../escape', content: 'x' }),
    ).rejects.toBeInstanceOf(SkillIdError);
  });
});

describe('installSkillFromPath', () => {
  it('installs from a dir containing SKILL.md (id = basename)', async () => {
    const srcDir = path.join(root, 'src', 'my-skill');
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.writeFile(path.join(srcDir, 'SKILL.md'), '# My Skill\n');
    const info = await installSkillFromPath({ source: srcDir });
    expect(info.id).toBe('my-skill');
    expect(
      await fsp.readFile(path.join(skillsDir(), 'my-skill', 'SKILL.md'), 'utf8'),
    ).toBe('# My Skill\n');
  });

  it('installs from a .md file (id = filename without .md)', async () => {
    const f = path.join(root, 'lint-helper.md');
    await fsp.writeFile(f, '# Lint Helper\n');
    const info = await installSkillFromPath({ source: f, id: 'linter' });
    expect(info.id).toBe('linter');
  });
});

describe('listSkills', () => {
  it('returns [] when the store does not exist', async () => {
    expect(await listSkills()).toEqual([]);
  });

  it('lists installed skills with link status, skipping .tmp- dirs', async () => {
    await installSkill({ id: 'alpha', content: 'a' });
    await installSkill({ id: 'beta', content: 'b' });
    await fsp.mkdir(path.join(skillsDir(), 'gamma.tmp-deadbeef'), {
      recursive: true,
    });
    const list = await listSkills();
    expect(list.map((s) => s.id)).toEqual(['alpha', 'beta']);
    expect(list.every((s) => s.linked)).toBe(true);
  });
});

describe('uninstallSkill', () => {
  it('removes the central dir and the agent symlink', async () => {
    await installSkill({ id: 'rev', content: 'x' });
    const res = await uninstallSkill({ id: 'rev' });
    expect(res).toEqual({ removedCentral: true, unlinkedAgent: true });
    await expect(
      fsp.stat(path.join(skillsDir(), 'rev')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fsp.lstat(path.join(claudeCommandsDir(), 'rev')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('throws SkillNotFoundError when nothing is installed', async () => {
    await expect(uninstallSkill({ id: 'ghost' })).rejects.toBeInstanceOf(
      SkillNotFoundError,
    );
  });

  it('NEVER removes a real (non-symlink) user dir at the agent path', async () => {
    await installSkill({ id: 'rev', content: 'x' });
    // User replaces the symlink with a real directory of their own.
    const agentPath = path.join(claudeCommandsDir(), 'rev');
    await fsp.rm(agentPath, { recursive: true, force: true });
    await fsp.mkdir(agentPath, { recursive: true });
    await fsp.writeFile(path.join(agentPath, 'mine.md'), 'user content');

    const res = await uninstallSkill({ id: 'rev' });
    expect(res.unlinkedAgent).toBe(false); // refused — not our symlink
    expect(res.removedCentral).toBe(true); // central is ours
    // The user's real dir + file survive untouched.
    expect(await fsp.readFile(path.join(agentPath, 'mine.md'), 'utf8')).toBe(
      'user content',
    );
  });
});
