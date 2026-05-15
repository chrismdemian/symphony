import {
  installSkillFromPath,
  listSkills,
  uninstallSkill,
  SkillInstallError,
  SkillNotFoundError,
} from '../skills/store.js';
import { SkillIdError } from '../skills/paths.js';

/**
 * Phase 4D.3 — `symphony skills {install,list,uninstall}` handlers.
 * Thin CLI shell over `src/skills/store.ts`; prints human output and
 * returns an exit code (mirrors `runReset`'s shape).
 */

export interface SkillsCliResult {
  readonly exitCode: number;
}

export async function runSkillsInstall(opts: {
  source: string;
  id?: string;
}): Promise<SkillsCliResult> {
  try {
    const info = await installSkillFromPath({
      source: opts.source,
      ...(opts.id !== undefined ? { id: opts.id } : {}),
    });
    console.log(
      `[symphony] installed skill '${info.id}' -> ${info.path} (agent link: ${
        info.linked ? 'ok' : 'skipped'
      })`,
    );
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof SkillIdError || err instanceof SkillInstallError) {
      console.error(`[symphony] ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
}

export async function runSkillsList(): Promise<SkillsCliResult> {
  const skills = await listSkills();
  if (skills.length === 0) {
    console.log('[symphony] no skills installed');
    return { exitCode: 0 };
  }
  for (const s of skills) {
    console.log(`${s.linked ? '*' : ' '} ${s.id}  ${s.path}`);
  }
  console.log(`[symphony] ${skills.length} skill(s) (* = linked into agent)`);
  return { exitCode: 0 };
}

export async function runSkillsUninstall(opts: {
  id: string;
}): Promise<SkillsCliResult> {
  try {
    const res = await uninstallSkill({ id: opts.id });
    console.log(
      `[symphony] uninstalled '${opts.id}' (central: ${
        res.removedCentral ? 'removed' : 'absent'
      }, agent link: ${res.unlinkedAgent ? 'removed' : 'absent'})`,
    );
    return { exitCode: 0 };
  } catch (err) {
    if (err instanceof SkillNotFoundError || err instanceof SkillIdError) {
      console.error(`[symphony] ${err.message}`);
      return { exitCode: 1 };
    }
    throw err;
  }
}
