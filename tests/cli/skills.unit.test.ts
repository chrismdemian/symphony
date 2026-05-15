import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runSkillsInstall,
  runSkillsList,
  runSkillsUninstall,
} from '../../src/cli/skills.js';
import {
  SYMPHONY_CLAUDE_COMMANDS_DIR_ENV,
  SYMPHONY_SKILLS_DIR_ENV,
} from '../../src/skills/paths.js';

let root: string;
let savedCentral: string | undefined;
let savedAgent: string | undefined;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'symphony-skills-cli-'));
  savedCentral = process.env[SYMPHONY_SKILLS_DIR_ENV];
  savedAgent = process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV];
  process.env[SYMPHONY_SKILLS_DIR_ENV] = path.join(root, 'central');
  process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV] = path.join(root, 'agent');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  if (savedCentral === undefined) delete process.env[SYMPHONY_SKILLS_DIR_ENV];
  else process.env[SYMPHONY_SKILLS_DIR_ENV] = savedCentral;
  if (savedAgent === undefined) delete process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV];
  else process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV] = savedAgent;
  vi.restoreAllMocks();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('skills CLI shell', () => {
  it('install → list → uninstall happy path returns exit 0', async () => {
    const f = path.join(root, 'my-skill.md');
    await fsp.writeFile(f, '# My Skill\n');

    expect(await runSkillsInstall({ source: f })).toEqual({ exitCode: 0 });
    expect(await runSkillsList()).toEqual({ exitCode: 0 });
    expect(await runSkillsUninstall({ id: 'my-skill' })).toEqual({
      exitCode: 0,
    });
  });

  it('install with a missing source returns exit 1 (handled, not thrown)', async () => {
    const res = await runSkillsInstall({
      source: path.join(root, 'nope'),
    });
    expect(res).toEqual({ exitCode: 1 });
  });

  it('uninstall of an unknown skill returns exit 1', async () => {
    expect(await runSkillsUninstall({ id: 'ghost' })).toEqual({ exitCode: 1 });
  });

  it('install honors an explicit --id override', async () => {
    const f = path.join(root, 'raw.md');
    await fsp.writeFile(f, 'x');
    expect(await runSkillsInstall({ source: f, id: 'renamed' })).toEqual({
      exitCode: 0,
    });
    const { listSkills } = await import('../../src/skills/store.js');
    expect((await listSkills()).map((s) => s.id)).toEqual(['renamed']);
  });
});
