/**
 * Vitest setup — forces chalk's color level to truecolor (3) so
 * `gradient-string` and other chalk-backed renderers emit ANSI escapes
 * even when vitest's stdout is non-TTY.
 *
 * Mirrors the runtime expectation: production runs in an interactive
 * terminal where chalk auto-detects color support. Tests must match.
 *
 * Reaches chalk through `gradient-string`'s own resolved path so we
 * don't need to add chalk as a direct dependency. The instance returned
 * is the SAME singleton gradient-string uses internally; mutating
 * `level` here propagates.
 */
import gradient from 'gradient-string';

// Phase 8C — never touch the real OS keychain from the test suite. The
// secrets module honors this flag (file-only fallback); keychain-path unit
// tests opt back in via `__setSecretBackendForTests` with a fake backend.
process.env.SYMPHONY_DISABLE_KEYRING = '1';

// Safety net: never let a unit/integration test read or WRITE the
// developer's real ~/.symphony/config.json. `loadConfig()`/`applyPatchToDisk()`
// take no `home` arg, so a test that forgets to isolate (or leaks an async
// write past its afterEach — the 5d-config-watch class that polluted the real
// config with `activeProject: should-not-leak`) silently corrupts it and every
// later test/scenario inherits the garbage. Tests that need specific config set
// their own SYMPHONY_CONFIG_FILE (overriding this); config.test.ts deletes it
// to exercise the default-path branch. Only seed it when unset.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
if (process.env.SYMPHONY_CONFIG_FILE === undefined) {
  process.env.SYMPHONY_CONFIG_FILE = join(
    mkdtempSync(join(tmpdir(), 'symphony-test-cfg-')),
    'config.json',
  );
}

// Force a small priming render so the chalk module behind gradient-string
// is fully initialized, then poke its level. We import chalk dynamically
// via require because it's a transitive dep — direct ESM import would
// require adding chalk to package.json.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Audit 3B.3 m4: chalk is a transitive dep of gradient-string. If pnpm
// hoist behavior changes (e.g., strict `public-hoist-pattern`), the
// require can throw and tank the entire vitest run before any tests
// load. Tolerate the failure — non-truecolor fallback is acceptable
// when chalk can't be reached.
try {
  const chalk: { level: number } = require('chalk').default ?? require('chalk');
  chalk.level = 3;
} catch {
  // chalk not resolvable in this hoist layout — tests that need
  // 24-bit ANSI escapes will degrade gracefully rather than crash.
}

// Sanity: warm gradient-string so it picks up the level. Without this
// the very first call in a test could miss the level mutation timing.
gradient(['#7C6FEB', '#D4A843'])('warm');
