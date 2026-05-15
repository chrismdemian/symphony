import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import {
  assertSafeSkillId,
  claudeCommandsDir,
  SKILL_MANIFEST,
  skillsDir,
} from './paths.js';

/**
 * Phase 4D.3 — persistent (Tier 2) user skill store. Port of emdash
 * `SkillsService.ts:411-564`.
 *
 *  - Atomic install: write `<id>.tmp-<rand>/SKILL.md`, drop any stale
 *    final dir, `rename()` (one syscall) into place, then symlink the
 *    agent dir at it. A failed install cleans BOTH tmp and final.
 *  - Symlinks use `'junction'` on Win32 (regular dir symlinks need
 *    elevation; junctions don't). The central store path is absolute,
 *    which junctions require.
 *  - Uninstall is symlink-only for the AGENT side: only unlink a target
 *    that is a symlink resolving INTO the central store — never `rm` a
 *    real user directory. The central dir IS Symphony-owned, so that is
 *    removed.
 */

export interface SkillInfo {
  readonly id: string;
  /** Absolute path of the central source dir. */
  readonly path: string;
  /** Agent symlink present AND resolving into the central store. */
  readonly linked: boolean;
}

export class SkillInstallError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SkillInstallError';
  }
}

export class SkillNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`skill '${id}' is not installed`);
    this.name = 'SkillNotFoundError';
  }
}

function symlinkType(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

/**
 * Point `~/.claude/commands/<id>` at `<central>/<id>`. Removes a prior
 * symlink OR directory at the target first (the id namespace under the
 * agent commands dir is Symphony-claimed once the user runs
 * `symphony skills install`). emdash `SkillsService.ts:515-543`.
 */
async function syncToAgents(id: string, home?: string): Promise<void> {
  const src = path.resolve(skillsDir(home), id);
  const target = path.join(claudeCommandsDir(home), id);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    const st = await fsp.lstat(target);
    if (st.isSymbolicLink() || st.isDirectory()) {
      await fsp.rm(target, { recursive: true, force: true });
    } else {
      await fsp.unlink(target);
    }
  } catch {
    /* nothing there — fine */
  }
  await fsp.symlink(src, target, symlinkType());
}

/**
 * Remove the agent symlink ONLY if it is a symlink resolving into the
 * central store. A real user directory at that path is never touched
 * (emdash `SkillsService.ts:546-564`). Returns whether it unlinked.
 */
async function unsyncFromAgents(id: string, home?: string): Promise<boolean> {
  const target = path.join(claudeCommandsDir(home), id);
  const centralRoot = path.resolve(skillsDir(home));
  try {
    const st = await fsp.lstat(target);
    if (!st.isSymbolicLink()) return false;
    const link = await fsp.readlink(target);
    const resolved = path.resolve(path.dirname(target), link);
    if (
      resolved === path.join(centralRoot, id) ||
      resolved.startsWith(centralRoot + path.sep)
    ) {
      await fsp.unlink(target);
      return true;
    }
  } catch {
    /* not present / not removable — skip */
  }
  return false;
}

/** Install (or replace) a skill from raw `SKILL.md` content. */
export async function installSkill(opts: {
  id: string;
  content: string;
  home?: string;
}): Promise<SkillInfo> {
  const id = assertSafeSkillId(opts.id);
  const finalDir = path.join(skillsDir(opts.home), id);
  const tmpDir = `${finalDir}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    await fsp.mkdir(tmpDir, { recursive: true });
    await fsp.writeFile(path.join(tmpDir, SKILL_MANIFEST), opts.content, 'utf8');
    // Drop a stale prior install (or a leftover from a crashed run)
    // BEFORE the atomic rename — rename onto a non-empty dir fails.
    await fsp.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rename(tmpDir, finalDir);
    await syncToAgents(id, opts.home);
    return { id, path: finalDir, linked: true };
  } catch (err) {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(finalDir, { recursive: true, force: true }).catch(() => {});
    throw new SkillInstallError(
      `failed to install skill '${id}': ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }
}

/**
 * Install from a path: a directory containing `SKILL.md`, or a `.md`
 * file used as the manifest. `id` defaults to the source basename
 * (without `.md`).
 */
export async function installSkillFromPath(opts: {
  source: string;
  id?: string;
  home?: string;
}): Promise<SkillInfo> {
  const source = path.resolve(opts.source);
  let content: string;
  let derivedId: string;
  const st = await fsp.stat(source).catch(() => {
    throw new SkillInstallError(`skill source not found: ${source}`);
  });
  if (st.isDirectory()) {
    content = await fsp
      .readFile(path.join(source, SKILL_MANIFEST), 'utf8')
      .catch(() => {
        throw new SkillInstallError(
          `no ${SKILL_MANIFEST} in skill source dir ${source}`,
        );
      });
    derivedId = path.basename(source);
  } else {
    content = await fsp.readFile(source, 'utf8');
    derivedId = path.basename(source).replace(/\.md$/i, '');
  }
  return installSkill({
    id: opts.id ?? derivedId,
    content,
    ...(opts.home !== undefined ? { home: opts.home } : {}),
  });
}

/** List installed skills with agent-link status. */
export async function listSkills(home?: string): Promise<SkillInfo[]> {
  const root = skillsDir(home);
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: SkillInfo[] = [];
  for (const name of entries.sort()) {
    if (name.includes('.tmp-')) continue; // skip in-flight installs
    const dir = path.join(root, name);
    let isDir: boolean;
    try {
      isDir = (await fsp.stat(dir)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    out.push({ id: name, path: dir, linked: await isLinked(name, home) });
  }
  return out;
}

async function isLinked(id: string, home?: string): Promise<boolean> {
  const target = path.join(claudeCommandsDir(home), id);
  const centralRoot = path.resolve(skillsDir(home));
  try {
    if (!(await fsp.lstat(target)).isSymbolicLink()) return false;
    const resolved = path.resolve(
      path.dirname(target),
      await fsp.readlink(target),
    );
    return (
      resolved === path.join(centralRoot, id) ||
      resolved.startsWith(centralRoot + path.sep)
    );
  } catch {
    return false;
  }
}

/**
 * Uninstall: drop the agent symlink (only if it points into the central
 * store) and remove the Symphony-owned central dir. Throws
 * {@link SkillNotFoundError} if nothing was installed under `id`.
 */
export async function uninstallSkill(opts: {
  id: string;
  home?: string;
}): Promise<{ removedCentral: boolean; unlinkedAgent: boolean }> {
  const id = assertSafeSkillId(opts.id);
  const finalDir = path.join(skillsDir(opts.home), id);
  const existed = await fsp
    .stat(finalDir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  const unlinkedAgent = await unsyncFromAgents(id, opts.home);
  if (!existed && !unlinkedAgent) {
    throw new SkillNotFoundError(id);
  }
  let removedCentral = false;
  if (existed) {
    await fsp.rm(finalDir, { recursive: true, force: true });
    removedCentral = true;
  }
  return { removedCentral, unlinkedAgent };
}
