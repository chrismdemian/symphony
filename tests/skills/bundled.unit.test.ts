import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUNDLED_SKILLS,
  installBundledSkills,
} from '../../src/skills/bundled.js';
import { listSkills } from '../../src/skills/store.js';
import {
  SKILL_MANIFEST,
  skillsDir,
  SYMPHONY_CLAUDE_COMMANDS_DIR_ENV,
  SYMPHONY_SKILLS_DIR_ENV,
} from '../../src/skills/paths.js';

let root: string;
let savedCentral: string | undefined;
let savedAgent: string | undefined;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'symphony-bundled-'));
  savedCentral = process.env[SYMPHONY_SKILLS_DIR_ENV];
  savedAgent = process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV];
  process.env[SYMPHONY_SKILLS_DIR_ENV] = path.join(root, 'central');
  process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV] = path.join(root, 'agent');
});

afterEach(async () => {
  if (savedCentral === undefined) delete process.env[SYMPHONY_SKILLS_DIR_ENV];
  else process.env[SYMPHONY_SKILLS_DIR_ENV] = savedCentral;
  if (savedAgent === undefined) delete process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV];
  else process.env[SYMPHONY_CLAUDE_COMMANDS_DIR_ENV] = savedAgent;
  await fsp.rm(root, { recursive: true, force: true });
});

describe('installBundledSkills', () => {
  it('installs the v1 bundled set (dev-browser + json-render), linked', async () => {
    const res = await installBundledSkills();
    expect([...res.installed].sort()).toEqual(['dev-browser', 'json-render']);
    expect(res.skipped).toEqual([]);

    const list = await listSkills();
    expect(list.map((s) => s.id).sort()).toEqual(['dev-browser', 'json-render']);
    expect(list.every((s) => s.linked)).toBe(true);

    for (const b of BUNDLED_SKILLS) {
      const onDisk = await fsp.readFile(
        path.join(skillsDir(), b.id, SKILL_MANIFEST),
        'utf8',
      );
      expect(onDisk).toBe(b.content);
    }
  });

  it('is idempotent — a second run skips everything (cheap re-boot)', async () => {
    await installBundledSkills();
    const second = await installBundledSkills();
    expect(second.installed).toEqual([]);
    expect([...second.skipped].sort()).toEqual(['dev-browser', 'json-render']);
  });

  it('reinstalls a skill whose content drifted', async () => {
    await installBundledSkills();
    await fsp.writeFile(
      path.join(skillsDir(), 'dev-browser', SKILL_MANIFEST),
      'tampered',
    );
    const res = await installBundledSkills();
    expect(res.installed).toEqual(['dev-browser']);
    expect(res.skipped).toEqual(['json-render']);
    expect(
      await fsp.readFile(
        path.join(skillsDir(), 'dev-browser', SKILL_MANIFEST),
        'utf8',
      ),
    ).toBe(BUNDLED_SKILLS.find((b) => b.id === 'dev-browser')!.content);
  });

  it('force reinstalls even when up-to-date', async () => {
    await installBundledSkills();
    const forced = await installBundledSkills({ force: true });
    expect([...forced.installed].sort()).toEqual(['dev-browser', 'json-render']);
    expect(forced.skipped).toEqual([]);
  });

  it('re-links a present-but-unlinked skill (idempotency requires the link)', async () => {
    await installBundledSkills();
    // Simulate the agent symlink being removed out-of-band.
    await fsp.rm(path.join(root, 'agent', 'json-render'), {
      recursive: true,
      force: true,
    });
    const res = await installBundledSkills();
    expect(res.installed).toEqual(['json-render']);
    const list = await listSkills();
    expect(list.find((s) => s.id === 'json-render')?.linked).toBe(true);
  });
});
