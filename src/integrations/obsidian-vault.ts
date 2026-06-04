import { promises as fsp, type Dirent } from 'node:fs';
import path from 'node:path';

/**
 * Phase 8B — the narrow filesystem slice the Obsidian connector needs, behind
 * an injectable seam (the filesystem analogue of `notion-client.ts`). Defining
 * it here keeps `ObsidianConnector` testable against a hand-written in-memory
 * vault and documents exactly which fs operations we depend on.
 *
 * All paths crossing the seam are VAULT-RELATIVE, posix-separated (`a/b.md`),
 * so external-link ids are stable across platforms regardless of the absolute
 * vault location or the OS path separator.
 */

export interface VaultFsLike {
  /** The absolute vault root (display / `obsidian://` URI construction). */
  readonly root: string;
  /** Vault-relative posix paths of every `.md` file (honoring excludes). */
  listMarkdownFiles(): Promise<readonly string[]>;
  /** Read a vault-relative file as UTF-8. */
  readFile(relPath: string): Promise<string>;
  /**
   * Write a vault-relative file atomically (tmp + rename). Writes to the same
   * file are SERIALIZED per relative path so concurrent writebacks (N tasks
   * in one file completing at once) never clobber each other.
   */
  writeFile(relPath: string, content: string): Promise<void>;
  /** True when the vault root exists and is a directory. */
  isVault(): Promise<boolean>;
}

export interface CreateVaultFsOptions {
  /** Substring fragments (posix) to exclude from the file walk. */
  readonly exclude?: readonly string[];
  /** Max recursion depth for the walk (defense against pathological vaults). */
  readonly maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 12;

/**
 * Default `VaultFsLike` over `node:fs/promises`. The walk skips dotfolders by
 * default plus any configured exclude fragment; writes go through a per-path
 * promise chain (mirrors the 5C task-notes mirror queue) so simultaneous
 * writebacks to the same note serialize instead of racing the tmp+rename.
 */
export function createVaultFs(
  root: string,
  options: CreateVaultFsOptions = {},
): VaultFsLike {
  const absRoot = path.resolve(root);
  const exclude = options.exclude ?? ['.trash/', '.obsidian/'];
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const writeTails = new Map<string, Promise<void>>();

  function toPosix(rel: string): string {
    return rel.split(path.sep).join('/');
  }

  function isExcluded(relPosix: string): boolean {
    // Always skip dot-directories (`.obsidian`, `.git`, `.trash`).
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
      return; // unreadable subdir — skip, don't abort the whole walk
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
    // prior one rejected (5C mirror-queue pattern).
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
