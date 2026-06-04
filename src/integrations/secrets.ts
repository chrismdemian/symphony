import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Entry as KeyringEntry } from '@napi-rs/keyring';
import { symphonyDataDir, writeFileAtomic600 } from '../utils/config.js';

/**
 * Integration secret storage for connector tokens.
 *
 * Phase 8C upgrades the 8A file-based scheme to the **OS keychain** via
 * `@napi-rs/keyring` (Windows Credential Manager / macOS Keychain / libsecret),
 * with the original 0o600 file as a **fallback** when the keychain is
 * unavailable (headless Linux without a secret service, a load failure, etc.).
 * `@napi-rs/keyring` is the maintained successor to the archived `keytar` and
 * ships prebuilt platform binaries — no node-gyp / build step.
 *
 * Backend selection (`getBackend`):
 *   - a test-injected backend always wins (`__setSecretBackendForTests`);
 *   - `SYMPHONY_DISABLE_KEYRING=1` forces file-only;
 *   - a `home` override forces file-only — `home` means "isolate secrets under
 *     this dir", which is fundamentally incompatible with an OS-global
 *     keychain. Production never passes `home`, so production uses the keychain;
 *     every test passes `home` (or runs with the env flag), so tests never
 *     touch the real keychain;
 *   - otherwise the real keychain, lazily loaded (null if the native module
 *     fails to load — then we fall back to the file).
 *
 * Migration is automatic: `readToken` checks the keychain first, then falls
 * back to the legacy 0o600 file, so an existing `notion-token` keeps working;
 * the next `saveToken` moves it into the keychain and removes the file.
 *
 * The non-secret connector config (database id, repos, mappings) lives in a
 * sibling `<name>.json` sidecar (see `*-config.ts`) — never here.
 */

const INTEGRATIONS_DIRNAME = 'integrations';

/** Keychain service name; the account is `<integration>-token`. */
const KEYRING_SERVICE = 'symphony';

/** Resolve `~/.symphony/integrations/` (fallback-file storage + sidecars). */
export function integrationsDir(home?: string): string {
  return path.join(symphonyDataDir(home), INTEGRATIONS_DIRNAME);
}

function tokenFilePath(integration: string, home?: string): string {
  return path.join(integrationsDir(home), `${integration}-token`);
}

function keyringAccount(integration: string): string {
  return `${integration}-token`;
}

/**
 * Narrow backend the token helpers talk to. `get` returns `null` when no
 * entry exists; `delete` is idempotent. The real impl wraps the keychain
 * `Entry`; tests inject a fake.
 */
export interface SecretBackend {
  get(account: string): string | null;
  set(account: string, value: string): void;
  delete(account: string): void;
}

/**
 * Test seam. `undefined` (default) = real behavior; a `SecretBackend` =
 * exercise the keychain path against a fake; `null` = force "no keychain"
 * (file-only). Set back to `undefined` to restore.
 */
let testBackend: SecretBackend | null | undefined;

export function __setSecretBackendForTests(backend: SecretBackend | null | undefined): void {
  testBackend = backend;
  // Reset the lazy real-backend cache + the one-shot warning latch so a later
  // run re-probes and can warn again (cross-test isolation).
  realBackendCache = undefined;
  warnedFallback = false;
}

let realBackendCache: SecretBackend | null | undefined;
let warnedFallback = false;

function warnFallbackOnce(reason: string): void {
  if (warnedFallback) return;
  warnedFallback = true;
  console.warn(
    `[symphony] secrets: OS keychain unavailable (${reason}); ` +
      'storing integration tokens in ~/.symphony/integrations/<name>-token (mode 0600).',
  );
}

/**
 * Lazily load `@napi-rs/keyring` and wrap its `Entry` in a `SecretBackend`.
 * Cached. Returns `null` (file fallback) if the native module fails to load.
 * The dynamic import keeps the native binary off the module-init path.
 */
async function loadRealBackend(): Promise<SecretBackend | null> {
  if (realBackendCache !== undefined) return realBackendCache;
  try {
    const mod = await import('@napi-rs/keyring');
    const Entry = mod.Entry;
    realBackendCache = {
      get: (account) => new Entry(KEYRING_SERVICE, account).getPassword(),
      set: (account, value) => {
        new Entry(KEYRING_SERVICE, account).setPassword(value);
      },
      delete: (account) => {
        new Entry(KEYRING_SERVICE, account).deletePassword();
      },
    } satisfies SecretBackend;
  } catch (err) {
    warnFallbackOnce(err instanceof Error ? err.message : String(err));
    realBackendCache = null;
  }
  return realBackendCache;
}

async function getBackend(home?: string): Promise<SecretBackend | null> {
  if (testBackend !== undefined) return testBackend;
  if (process.env.SYMPHONY_DISABLE_KEYRING === '1') return null;
  // A home override means "isolate secrets to this dir" — incompatible with an
  // OS-global keychain. Production never passes home (→ keychain); tests do (→ file).
  if (home !== undefined) return null;
  return loadRealBackend();
}

async function readTokenFile(integration: string, home?: string): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(tokenFilePath(integration, home), 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function deleteTokenFile(integration: string, home?: string): Promise<void> {
  try {
    await fsp.unlink(tokenFilePath(integration, home));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Persist a token for `integration` (e.g. `'linear'`). Trimmed; an empty
 * token is rejected. Writes to the OS keychain when available (and removes any
 * legacy 0o600 file so the keychain is the single source); otherwise falls
 * back to an atomic 0o600 file.
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
  const backend = await getBackend(home);
  if (backend !== null) {
    try {
      backend.set(keyringAccount(integration), trimmed);
      // Migration: drop any stale file token so there's one source of truth.
      await deleteTokenFile(integration, home).catch(() => undefined);
      return;
    } catch (err) {
      warnFallbackOnce(err instanceof Error ? err.message : String(err));
    }
  }
  const dir = integrationsDir(home);
  await fsp.mkdir(dir, { recursive: true });
  await writeFileAtomic600(tokenFilePath(integration, home), trimmed);
}

/**
 * Read the stored token for `integration`. Checks the keychain first, then the
 * legacy 0o600 file (migration read path). Returns `undefined` when neither
 * holds a token. A keychain read error degrades to the file rather than
 * throwing; a non-ENOENT file error propagates (a corrupt token file is a real
 * problem, not "no token").
 */
export async function readToken(
  integration: string,
  home?: string,
): Promise<string | undefined> {
  const backend = await getBackend(home);
  if (backend !== null) {
    try {
      const value = backend.get(keyringAccount(integration));
      if (value !== null && value.trim().length > 0) return value.trim();
      // No keychain entry → fall through to the legacy file (migration).
    } catch (err) {
      warnFallbackOnce(err instanceof Error ? err.message : String(err));
    }
  }
  return readTokenFile(integration, home);
}

/** Remove a stored token from BOTH the keychain and the legacy file (idempotent). */
export async function deleteToken(integration: string, home?: string): Promise<void> {
  const backend = await getBackend(home);
  if (backend !== null) {
    try {
      backend.delete(keyringAccount(integration));
    } catch {
      // Best-effort — still clear the file below.
    }
  }
  await deleteTokenFile(integration, home);
}

// Keep the symbol referenced so type-only imports aren't flagged unused by
// some toolchains; `KeyringEntry` documents the shape `loadRealBackend` wraps.
export type { KeyringEntry };
