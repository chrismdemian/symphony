import fs from 'node:fs';
import path from 'node:path';

import type { SymphonyConfig } from './types.js';

/**
 * Read `.symphony.json` from the project root. Returns null on missing file
 * or parse error. Parse errors are swallowed on purpose — a malformed
 * config must not crash worktree creation.
 */
export function readSymphonyConfig(projectPath: string): SymphonyConfig | null {
  const configPath = path.join(projectPath, '.symphony.json');
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as SymphonyConfig;
  } catch {
    return null;
  }
}
