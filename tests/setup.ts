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
