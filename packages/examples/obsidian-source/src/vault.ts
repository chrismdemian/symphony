import { promises as fsp, type Dirent } from 'node:fs';
import path from 'node:path';

/**
 * obsidian-source — the narrow filesystem slice the connector needs, ported
 * from Symphony's in-tree `src/integrations/obsidian-vault.ts`. All paths
 * crossing the seam are VAULT-RELATIVE, posix-separated (`a/b.md`), so
 * external-link ids are stable across platforms.
 *
 * The plugin runs as a normal Node subprocess (Symphony's sandbox is env-only,
 * not fs-jailed), so it reads + writes the vault path from its config directly.
 */

export interface VaultFsLike {
  readonly root: string;
  listMarkdownFiles(): Promise<readonly string[]>;
  readFile(relPath: string): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  isVault(): Promise<boolean>;
}

export interface CreateVaultFsOptions {
  readonly exclude?: readonly string[];
  readonly maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 12;

export function createVaultFs(root: string, options: CreateVaultFsOptions = {}): VaultFsLike {
  const absRoot = path.resolve(root);
  const exclude = options.exclude ?? ['.trash/', '.obsidian/'];
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const writeTails = new Map<string, Promise<void>>();

  function toPosix(rel: string): string {
    return rel.split(path.sep).join('/');
  }

  function isExcluded(relPosix: string): boolean {
    if (relPosix.split('/').some((seg) => seg.startsWith('.'))) return true;
    return exclude.some((frag) => relPosix.includes(frag));
  }

  async function walk(dirRel: string, depth: number, out: string[]): Promise<void> {
    if (depth > maxDepth) return;
    const absDir = path.join(absRoot, dirRel);
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = dirRel.length > 0 ? `${dirRel}/${entry.name}` : entry.name;
      const childPosix = toPosix(childRel);
      if (entry.isDirectory()) {
        if (isExcluded(`${childPosix}/`)) continue;
        await walk(childRel, depth + 1, out);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        if (isExcluded(childPosix)) continue;
        out.push(childPosix);
      }
    }
  }

  async function listMarkdownFiles(): Promise<readonly string[]> {
    const out: string[] = [];
    await walk('', 0, out);
    out.sort();
    return out;
  }

  async function readFile(relPath: string): Promise<string> {
    return fsp.readFile(path.join(absRoot, relPath), 'utf8');
  }

  async function writeAtomic(relPath: string, content: string): Promise<void> {
    const abs = path.join(absRoot, relPath);
    const tmp = `${abs}.symphony-${process.pid}.tmp`;
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, abs);
  }

  function writeFile(relPath: string, content: string): Promise<void> {
    const key = toPosix(relPath);
    const prev = writeTails.get(key) ?? Promise.resolve();
    // Order, don't chain results: always attempt the next write even if the
    // prior one rejected (serialize writes to the same file).
    const next = prev.then(
      () => writeAtomic(relPath, content),
      () => writeAtomic(relPath, content),
    );
    writeTails.set(key, next);
    next
      .finally(() => {
        if (writeTails.get(key) === next) writeTails.delete(key);
      })
      .catch(() => {
        // passive pruner — caller's await observes the real outcome
      });
    return next;
  }

  async function isVault(): Promise<boolean> {
    try {
      const st = await fsp.stat(absRoot);
      return st.isDirectory();
    } catch {
      return false;
    }
  }

  return { root: absRoot, listMarkdownFiles, readFile, writeFile, isVault };
}
