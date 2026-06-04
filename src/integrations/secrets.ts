import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { symphonyDataDir, writeFileAtomic600 } from '../utils/config.js';

/**
 * Phase 8A — file-based secret storage for integration tokens.
 *
 * Tokens live one-per-file under `~/.symphony/integrations/` at mode 0o600
 * (POSIX; Win32 chmod is a no-op — NTFS ACLs apply). Non-secret config
 * (database id, property mappings) lives in a sibling `.json` sidecar (see
 * `notion-config.ts`) so a token never lands in a readable JSON blob.
 *
 * This is the deliberate pre-keytar shape (PLAN.md §8A decision): it reuses
 * Symphony's existing atomic `0o600` writer (the same one guarding
 * `config.json` / `rpc.json`) and adds no native dependency. Phase 8C swaps
 * to the OS keychain (keytar) when the shared connector module lands.
 */

const INTEGRATIONS_DIRNAME = 'integrations';

/** Resolve `~/.symphony/integrations/`. */
export function integrationsDir(home?: string): string {
  return path.join(symphonyDataDir(home), INTEGRATIONS_DIRNAME);
}

function tokenFilePath(integration: string, home?: string): string {
  return path.join(integrationsDir(home), `${integration}-token`);
}

/**
 * Persist a token for `integration` (e.g. `'notion'`). The token is
 * trimmed; an empty/blank token is rejected. Creates the integrations dir
 * if missing. Atomic + 0o600.
 */
export async function saveToken(
  integration: string,
  token: string,
  home?: string,
): Promise<void> {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    throw new Error(`saveToken: refusing to store an empty ${integration} token`);
  }
  const dir = integrationsDir(home);
  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomic600(tokenFilePath(integration, home), trimmed);
}

/**
 * Read the stored token for `integration`. Returns `undefined` when no
 * token file exists (ENOENT) or the file is blank. Other read errors
 * (permission, IO) propagate — a corrupt-but-present token file is a real
 * problem the caller should surface, not silently treat as "no token".
 */
export async function readToken(
  integration: string,
  home?: string,
): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(tokenFilePath(integration, home), 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Remove a stored token (idempotent — ENOENT is a no-op). */
export async function deleteToken(integration: string, home?: string): Promise<void> {
  try {
    await fsp.unlink(tokenFilePath(integration, home));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
