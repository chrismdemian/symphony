#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json`. Replays a fixture
// to stdout, optionally sleeping between lines to simulate streaming.
//
// Usage: node tests/helpers/fake-claude.mjs <fixture-name> [--delay-ms=N]
//   fixture-name: basename (without .ndjson) of a file under
//                 tests/fixtures/stream-json/, e.g. "happy-path".
//   --delay-ms:   optional per-line delay to exercise chunked reads.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '..', 'fixtures', 'stream-json');

const args = process.argv.slice(2);
const fixture = args[0];
if (!fixture) {
  process.stderr.write('fake-claude: fixture name required\n');
  process.exit(2);
}

const delayArg = args.find((a) => a.startsWith('--delay-ms='));
const delayMs = delayArg ? Number(delayArg.split('=')[1]) : 0;

const path = join(fixturesDir, `${fixture}.ndjson`);
const text = readFileSync(path, 'utf8');
const lines = text.split('\n').filter((l) => l.length > 0);

for (const line of lines) {
  process.stdout.write(line + '\n');
  if (delayMs > 0) await wait(delayMs);
}

process.exit(0);
