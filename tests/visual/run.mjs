#!/usr/bin/env node
/**
 * Cross-platform launcher for visual harnesses.
 *
 * Sets `FORCE_COLOR=3` BEFORE the child Node process starts so chalk
 * (Ink's color backend) emits 24-bit RGB escapes even when stdout is
 * a non-TTY mock from `ink-testing-library`. ESM hoisting prevents us
 * from setting this in the harness file itself — chalk's level is
 * resolved at import time, before user code runs.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
if (target === undefined) {
  process.stderr.write('usage: node tests/visual/run.mjs <harness.tsx>\n');
  process.exit(2);
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', path.resolve(here, '..', '..', target)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      FORCE_COLOR: '3',
      // chalk also honors COLORTERM=truecolor as a redundant signal
      // for terminals that don't set FORCE_COLOR.
      COLORTERM: 'truecolor',
    },
  },
);
process.exit(result.status ?? 1);
