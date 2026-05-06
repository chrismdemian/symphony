import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { symphonyDataDir } from '../utils/config.js';

const CURRENT_DB_FILENAME = 'symphony.db';

/**
 * Resolve the SQLite file path.
 *
 * Precedence:
 *   1. `SYMPHONY_DB_FILE` env var (absolute path, mirrors emdash's
 *      `EMDASH_DB_FILE` convention — tests and CI use this).
 *   2. `~/.symphony/symphony.db` default.
 *
 * Callers must `mkdirSync(dirname(path), { recursive: true })` before
 * opening the DB — this module only resolves, it doesn't create.
 */
/**
 * better-sqlite3 in-memory sentinel — never path-resolve, never mkdir.
 * Per CLAUDE.md "Discovered during implementation" 2B.1 (m2): the override
 * branch was `path.resolve`ing `:memory:` into a real path on disk, so
 * `SYMPHONY_DB_FILE=:memory:` ended up writing to `<cwd>/:memory:`.
 */
export const IN_MEMORY_SENTINEL = ':memory:';

export function resolveDatabasePath(): string {
  const override = process.env.SYMPHONY_DB_FILE?.trim();
  if (override && override.length > 0) {
    if (override === IN_MEMORY_SENTINEL) return IN_MEMORY_SENTINEL;
    return path.resolve(override);
  }
  return path.join(symphonyDataDir(), CURRENT_DB_FILENAME);
}

/**
 * Resolve the directory holding `0001_initial.sql` etc.
 *
 * Two shapes:
 *  - Source-run (tsx / vitest): files live at `src/state/migrations/`.
 *  - Bundled (tsup): tsup copies them to `dist/migrations/` via
 *    `onSuccess` — but tsup doesn't copy assets natively, so at runtime
 *    we look relative to `import.meta.url` for both shapes.
 *
 * Callers pass an explicit `migrationsDir` in tests to keep resolution
 * out of the critical path.
 */
export function resolveMigrationsPath(moduleUrl: string = import.meta.url): string {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.join(here, 'migrations'),          // src/state/migrations (tsx)
    path.join(here, '..', 'migrations'),    // dist/migrations (alt bundle layout)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  // Fallback — let the caller surface an ENOENT with the path they passed.
  return candidates[0]!;
}
