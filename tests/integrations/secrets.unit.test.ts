import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  saveToken,
  readToken,
  deleteToken,
  integrationsDir,
  __setSecretBackendForTests,
  type SecretBackend,
} from '../../src/integrations/secrets.js';

/**
 * Phase 8C — secret storage: keychain path (injected fake) + 0o600 file
 * fallback + migration read. The suite runs with SYMPHONY_DISABLE_KEYRING=1
 * (tests/setup.ts), so the real keychain is never touched; keychain-path tests
 * opt back in with `__setSecretBackendForTests`.
 */

function memoryBackend(): SecretBackend & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (account) => store.get(account) ?? null,
    set: (account, value) => {
      store.set(account, value);
    },
    delete: (account) => {
      store.delete(account);
    },
  };
}

function tokenFile(home: string, integration: string): string {
  return path.join(integrationsDir(home), `${integration}-token`);
}

describe('secrets — keychain path (injected backend)', () => {
  afterEach(() => __setSecretBackendForTests(undefined));

  it('round-trips a token through the keychain backend without writing a file', async () => {
    const backend = memoryBackend();
    __setSecretBackendForTests(backend);
    // home undefined → keychain path (the injected backend wins over the env flag).
    await saveToken('linear', '  lin_api_secret  ');
    expect(backend.store.get('linear-token')).toBe('lin_api_secret'); // trimmed
    expect(await readToken('linear')).toBe('lin_api_secret');
    await deleteToken('linear');
    expect(backend.store.has('linear-token')).toBe(false);
    expect(await readToken('linear')).toBeUndefined();
  });

  it('refuses to store an empty token', async () => {
    __setSecretBackendForTests(memoryBackend());
    await expect(saveToken('linear', '   ')).rejects.toThrow(/empty/);
  });
});

describe('secrets — file fallback + migration', () => {
  let home: string;
  afterEach(() => {
    __setSecretBackendForTests(undefined);
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });

  it('falls back to a 0o600 file when the keychain throws', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-secrets-'));
    const throwing: SecretBackend = {
      get: () => {
        throw new Error('keychain locked');
      },
      set: () => {
        throw new Error('keychain locked');
      },
      delete: () => {
        throw new Error('keychain locked');
      },
    };
    __setSecretBackendForTests(throwing);
    await saveToken('github', 'ghp_token', home);
    expect(existsSync(tokenFile(home, 'github'))).toBe(true);
    expect(readFileSync(tokenFile(home, 'github'), 'utf8')).toBe('ghp_token');
    // read also degrades to the file when the keychain throws.
    expect(await readToken('github', home)).toBe('ghp_token');
    await deleteToken('github', home);
    expect(existsSync(tokenFile(home, 'github'))).toBe(false);
  });

  it('reads a legacy file token when the keychain has no entry (migration read)', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-secrets-'));
    // Empty keychain backend (get → null) so read falls through to the file.
    __setSecretBackendForTests(memoryBackend());
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(tokenFile(home, 'notion'), 'legacy_notion_token\n', 'utf8');
    expect(await readToken('notion', home)).toBe('legacy_notion_token');
  });

  it('with a home override (file mode) writes + reads the file directly', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-secrets-'));
    // No inject → SYMPHONY_DISABLE_KEYRING=1 + home override both force file mode.
    await saveToken('linear', 'lin_file_token', home);
    expect(existsSync(tokenFile(home, 'linear'))).toBe(true);
    expect(await readToken('linear', home)).toBe('lin_file_token');
    expect(await readToken('linear', home)).not.toBeUndefined();
    await deleteToken('linear', home);
    expect(await readToken('linear', home)).toBeUndefined();
  });

  it('migrates a file token into the keychain on the next save', async () => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-secrets-'));
    const backend = memoryBackend();
    // Seed a legacy file token, then inject a working keychain backend.
    mkdirSync(integrationsDir(home), { recursive: true });
    writeFileSync(tokenFile(home, 'linear'), 'old_token', 'utf8');
    __setSecretBackendForTests(backend);
    // Save with a home override would force file mode — but the injected backend
    // wins, so this exercises the keychain write + file cleanup migration.
    await saveToken('linear', 'new_token', home);
    expect(backend.store.get('linear-token')).toBe('new_token');
    // The legacy file is removed so the keychain is the single source.
    expect(existsSync(tokenFile(home, 'linear'))).toBe(false);
  });
});
