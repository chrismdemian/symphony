import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  composeMaestroPrompt,
  type MaestroPromptVars,
} from '../../src/orchestrator/maestro/prompt-composer.js';
import {
  composeWorkerPrompt,
  type WorkerPromptVars,
} from '../../src/workers/prompt-composer.js';
import {
  generateFragmentsFromV1,
  MAESTRO_FRAGMENT_FILES,
  MAESTRO_FRAGMENT_SEPARATOR,
  NEW_TASK_GUARD,
  PromptComposer,
  PromptFragmentLoadError,
  resolveFragmentsDir,
  WORKER_COMMON_SUFFIX_FRAGMENT,
  WORKER_ROLE_FRAGMENT_FILES,
} from '../../src/orchestrator/prompts/prompt-composer.js';
import type { WorkerRole } from '../../src/orchestrator/types.js';

const PROMPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'research',
  'prompts',
);
const FRAGMENTS_DIR = path.join(PROMPTS_DIR, 'fragments');

const ROLES: readonly WorkerRole[] = [
  'implementer',
  'researcher',
  'reviewer',
  'debugger',
  'planner',
];

// Var matrix: a fully-populated set + an all-empty set (→ `(none)` /
// boolean rendering) so substitution rules are exercised on both ends.
const MAESTRO_VAR_MATRIX: readonly MaestroPromptVars[] = [
  {
    projectName: 'symphony',
    registeredProjects: 'symphony, axon',
    workersInFlight: 'W1 (auth), W2 (ui)',
    currentMode: 'ACT',
    autonomyDefault: '2',
    planModeRequired: true,
    previewCommand: 'pnpm dev',
    availableTools: 'spawn_worker, finalize',
    maestroWarmth: 'balanced',
    modelMode: 'mixed',
  },
  {
    projectName: '',
    registeredProjects: '',
    workersInFlight: '',
    currentMode: 'PLAN',
    autonomyDefault: '1',
    planModeRequired: false,
    previewCommand: '',
    availableTools: '',
    maestroWarmth: '',
    modelMode: 'opus',
  },
];

const WORKER_VAR_MATRIX: readonly WorkerPromptVars[] = [
  {
    projectName: 'symphony',
    worktreePath: '/p/.symphony/worktrees/w1',
    featureIntent: 'add auth',
    autonomyTier: '2',
    siblingWorkers: '- ui — /p/.symphony/worktrees/w2',
    negativeConstraints: 'do not touch src/legacy',
    definitionOfDone: 'tests pass',
    testCmd: 'pnpm test',
    buildCmd: 'pnpm build',
    lintCmd: 'pnpm lint',
    previewCmd: 'pnpm dev',
  },
  {
    projectName: '',
    worktreePath: '',
    featureIntent: '',
    autonomyTier: '1',
    siblingWorkers: '',
    negativeConstraints: '',
    definitionOfDone: '',
    testCmd: '',
    buildCmd: '',
    lintCmd: '',
    previewCmd: '',
  },
];

describe('PromptComposer — fragment generation fidelity', () => {
  it('Maestro v1 splits into exactly the manifest length, separator-faithful', () => {
    // generateFragmentsFromV1 throws if the split count != manifest or
    // the rejoin != body. Reaching here proves both invariants.
    const generated = generateFragmentsFromV1(PROMPTS_DIR);
    const maestro = generated.filter((g) =>
      (MAESTRO_FRAGMENT_FILES as readonly string[]).includes(g.file),
    );
    expect(maestro).toHaveLength(MAESTRO_FRAGMENT_FILES.length);
    expect(generated).toHaveLength(MAESTRO_FRAGMENT_FILES.length + ROLES.length + 1);
  });

  it('committed fragment files match freshly-generated content (drift guard)', () => {
    for (const { file, content } of generateFragmentsFromV1(PROMPTS_DIR)) {
      const onDisk = fs.readFileSync(path.join(FRAGMENTS_DIR, file), 'utf8');
      expect(onDisk, `${file} drifted — run \`pnpm gen:fragments\``).toBe(content);
    }
  });

  it('every manifest fragment file exists on disk', () => {
    for (const name of [
      ...MAESTRO_FRAGMENT_FILES,
      ...Object.values(WORKER_ROLE_FRAGMENT_FILES),
      WORKER_COMMON_SUFFIX_FRAGMENT,
    ]) {
      expect(fs.existsSync(path.join(FRAGMENTS_DIR, name)), name).toBe(true);
    }
  });
});

describe('PromptComposer — byte-equivalence with the frozen monolith composers', () => {
  const composer = new PromptComposer({ fragmentsDir: FRAGMENTS_DIR });

  it('composeMaestro === composeMaestroPrompt across the var matrix', () => {
    for (const vars of MAESTRO_VAR_MATRIX) {
      const fromFragments = composer.composeMaestro(vars);
      const fromMonolith = composeMaestroPrompt(vars, { promptsDir: PROMPTS_DIR });
      expect(fromFragments).toBe(fromMonolith);
    }
  });

  it('composeWorker === composeWorkerPrompt for every role × var matrix', () => {
    const task = 'Wire {feature_intent} into src/app.ts:42 — keep {token} literal.';
    for (const role of ROLES) {
      for (const vars of WORKER_VAR_MATRIX) {
        const fromFragments = composer.composeWorker(role, task, vars);
        const fromMonolith = composeWorkerPrompt(role, task, vars, {
          promptsDir: PROMPTS_DIR,
        });
        expect(fromFragments, `${role}`).toBe(fromMonolith);
      }
    }
  });

  it('manual + separator + kickoff reconstitutes composeWorker exactly', () => {
    const task = 'do the thing';
    for (const role of ROLES) {
      const vars = WORKER_VAR_MATRIX[0]!;
      const split =
        composer.composeWorkerManual(role, vars) +
        MAESTRO_FRAGMENT_SEPARATOR +
        composer.composeWorkerTaskKickoff(task);
      expect(split).toBe(composer.composeWorker(role, task, vars));
      expect(split).toBe(
        composeWorkerPrompt(role, task, vars, { promptsDir: PROMPTS_DIR }),
      );
    }
  });
});

describe('PromptComposer — substitution + kickoff semantics', () => {
  const composer = new PromptComposer({ fragmentsDir: FRAGMENTS_DIR });

  it('empty vars render the literal (none), booleans render true/false', () => {
    const maestro = composer.composeMaestro(MAESTRO_VAR_MATRIX[1]!);
    expect(maestro).toContain('Active project: (none)');
    expect(maestro).toContain(
      'USER has set plan-mode-required for this project: false',
    );
  });

  it('task body is appended verbatim — a literal {token} is NOT substituted', () => {
    const task = 'Handle the {feature_intent} placeholder literally.';
    const out = composer.composeWorker('implementer', task, WORKER_VAR_MATRIX[0]!);
    expect(out).toContain(`# Your Task\n\n${task}\n`);
  });

  it('staleWorktree prepends the verbatim NEW_TASK_GUARD', () => {
    const kickoff = composer.composeWorkerTaskKickoff('redo it', {
      staleWorktree: true,
    });
    expect(kickoff.startsWith(`${NEW_TASK_GUARD}\n\n# Your Task`)).toBe(true);
    expect(
      composer.composeWorkerTaskKickoff('redo it').startsWith('# Your Task'),
    ).toBe(true);
  });
});

describe('PromptComposer — error surfaces', () => {
  it('unknown role throws PromptFragmentLoadError before any fs read', () => {
    const composer = new PromptComposer({ fragmentsDir: FRAGMENTS_DIR });
    expect(() =>
      composer.composeWorkerManual('nope' as WorkerRole, WORKER_VAR_MATRIX[0]!),
    ).toThrow(PromptFragmentLoadError);
  });

  it('missing fragments dir throws with a regen hint', () => {
    const composer = new PromptComposer({
      fragmentsDir: path.join(PROMPTS_DIR, '__does_not_exist__'),
    });
    expect(() => composer.composeMaestro(MAESTRO_VAR_MATRIX[0]!)).toThrow(
      /pnpm gen:fragments/,
    );
  });

  it('resolveFragmentsDir derives <promptsDir>/fragments', () => {
    expect(resolveFragmentsDir(PROMPTS_DIR)).toBe(FRAGMENTS_DIR);
  });
});
