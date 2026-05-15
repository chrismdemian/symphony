/**
 * `pnpm gen:fragments` — (re)generate `research/prompts/fragments/*.md`
 * from the frozen v1 artifacts.
 *
 * The v1 files in `research/prompts/` stay authoritative and unedited.
 * This script is the maintenance path for Phase 4D.1: after any edit to
 * a `*-v1.md` artifact, re-run it so the committed fragments stay in
 * lockstep. The equivalence unit test fails CI if they drift.
 *
 * Pure logic lives in `generateFragmentsFromV1` — this is just I/O.
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveMaestroPromptsDir } from '../src/orchestrator/maestro/prompt-composer.js';
import { generateFragmentsFromV1 } from '../src/orchestrator/prompts/prompt-composer.js';

const promptsDir = resolveMaestroPromptsDir();
const fragmentsDir = path.join(promptsDir, 'fragments');
fs.mkdirSync(fragmentsDir, { recursive: true });

const fragments = generateFragmentsFromV1(promptsDir);
let changed = 0;
for (const { file, content } of fragments) {
  const target = path.join(fragmentsDir, file);
  const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (prev !== content) {
    fs.writeFileSync(target, content);
    changed += 1;
  }
}

console.log(
  `[gen:fragments] ${fragments.length} fragments (${changed} changed) -> ${fragmentsDir}`,
);
