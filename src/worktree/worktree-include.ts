import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse `.worktreeinclude` content. Gitignore-style:
 *   - Comment lines starting with `#` are dropped.
 *   - Blank lines are dropped.
 *   - Leading and trailing whitespace is trimmed.
 *   - Negation patterns (`!foo`) are preserved verbatim so downstream
 *     minimatch callers can honor them.
 *
 * Returns an empty array if the content yields no real patterns. Returns
 * null only if the file does not exist or can't be read — callers use
 * that signal to fall through to the next precedence layer
 * (`.symphony.json` `preservePatterns`, then defaults).
 */
export function parseWorktreeIncludeContent(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    out.push(trimmed);
  }
  return out;
}

export function readWorktreeInclude(projectPath: string): string[] | null {
  const configPath = path.join(projectPath, '.worktreeinclude');
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  return parseWorktreeIncludeContent(content);
}
