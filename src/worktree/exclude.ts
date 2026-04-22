import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function resolveGitDir(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-dir'], {
    cwd: worktreePath,
  });
  const raw = stdout.trim();
  if (!raw) {
    throw new Error(`git rev-parse --git-dir returned empty for ${worktreePath}`);
  }
  return path.isAbsolute(raw) ? raw : path.join(worktreePath, raw);
}

/**
 * Append patterns to `.git/info/exclude` inside the worktree. Idempotent —
 * patterns already present are skipped. A trailing newline is always
 * written so subsequent appends land on a fresh line.
 *
 * Multica parity: `server/internal/daemon/repocache/cache.go:603-637`.
 */
export async function excludeFromGit(
  worktreePath: string,
  patterns: readonly string[],
): Promise<void> {
  if (patterns.length === 0) return;
  const gitDir = await resolveGitDir(worktreePath);
  const infoDir = path.join(gitDir, 'info');
  const excludePath = path.join(infoDir, 'exclude');

  fs.mkdirSync(infoDir, { recursive: true });

  let existing: string;
  try {
    existing = fs.readFileSync(excludePath, 'utf8');
  } catch {
    existing = '';
  }

  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#')),
  );

  const toAppend = patterns.filter((p) => !existingLines.has(p.trim()));
  if (toAppend.length === 0) return;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  const block = `${needsLeadingNewline ? '\n' : ''}${toAppend.join('\n')}\n`;

  fs.appendFileSync(excludePath, block, { mode: 0o644 });
}
