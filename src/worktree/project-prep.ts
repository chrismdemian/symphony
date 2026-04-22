import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface LockfileMatch {
  readonly file: string;
  readonly commands: readonly string[];
}

const LOCKFILE_MATRIX: readonly LockfileMatch[] = [
  { file: 'pnpm-lock.yaml', commands: ['pnpm install --frozen-lockfile', 'pnpm install'] },
  {
    file: 'yarn.lock',
    commands: ['yarn install --immutable', 'yarn install --frozen-lockfile', 'yarn install'],
  },
  { file: 'bun.lockb', commands: ['bun install'] },
  { file: 'package-lock.json', commands: ['npm ci', 'npm install'] },
  { file: 'Pipfile.lock', commands: ['pipenv install --deploy'] },
  { file: 'poetry.lock', commands: ['poetry install --no-root'] },
  { file: 'uv.lock', commands: ['uv sync --frozen'] },
  { file: 'Cargo.lock', commands: ['cargo fetch'] },
  { file: 'go.sum', commands: ['go mod download'] },
];

export interface ProjectPrepResult {
  readonly detected: string | null;
  readonly spawned: boolean;
}

function detectLockfile(target: string): LockfileMatch | null {
  for (const entry of LOCKFILE_MATRIX) {
    if (fs.existsSync(path.join(target, entry.file))) return entry;
  }
  return null;
}

function runInBackground(commands: readonly string[], cwd: string): void {
  if (commands.length === 0) return;
  const joined = commands.join(' || ');
  const child = spawn(joined, {
    cwd,
    shell: true,
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  child.on('error', () => {
    /* intentional swallow — best effort */
  });
  child.unref?.();
}

/**
 * Best-effort dependency prep. Detects the first lockfile we know and
 * spawns a background install so the first worker tool call has
 * `node_modules` / venv / vendor primed. Failure-silent.
 *
 * Skips Node installs when `node_modules` already exists so we don't
 * double-install after `git worktree add` on a repo that happens to
 * track `node_modules` (unusual but possible).
 */
export function ensureProjectPrepared(targetPath: string): ProjectPrepResult {
  try {
    const match = detectLockfile(targetPath);
    if (!match) return { detected: null, spawned: false };
    if (
      (match.file === 'pnpm-lock.yaml' ||
        match.file === 'yarn.lock' ||
        match.file === 'package-lock.json' ||
        match.file === 'bun.lockb') &&
      fs.existsSync(path.join(targetPath, 'node_modules'))
    ) {
      return { detected: match.file, spawned: false };
    }
    runInBackground(match.commands, targetPath);
    return { detected: match.file, spawned: true };
  } catch {
    return { detected: null, spawned: false };
  }
}
