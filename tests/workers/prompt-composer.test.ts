import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  composeWorkerPrompt,
  loadWorkerPromptArtifacts,
  resolveWorkerPromptsDir,
  WorkerPromptLoadError,
  type WorkerPromptVars,
} from '../../src/workers/prompt-composer.js';
import { WORKER_ROLES } from '../../src/orchestrator/types.js';

// Opener fixture shape mirrors the real `role-opener-*-v1.md`: H1 title,
// a `>` meta note, a `---` separator, then `## Your Role:` onward. The
// opener references `{test_cmd}` to prove substitution covers the opener
// region (the real reviewer opener does this).
function openerFixture(role: string): string {
  return `# Role Opener — ${role} (v1)

> Prepends to worker-common-suffix-v1.md. META NOTE — must be stripped.

---

## Your Role: ${role}

Re-run {test_cmd} yourself. Do not trust pasted output.
`;
}

const SUFFIX_FIXTURE = `# Worker Common Suffix — v1

**Template variables**: {project_name} … META — must be stripped.

## BEGIN SUFFIX

You work in: {worktree_path}
Project: {project_name}
Feature intent: {feature_intent}
Autonomy tier: {autonomy_tier}

### Siblings
{sibling_workers}

### Negative Constraints
{negative_constraints}

### Definition of Done
{definition_of_done}

Build: {build_cmd} · Lint: {lint_cmd} · Preview: {preview_cmd}

Unknown token stays literal: {not_a_real_token}

### Reporting Format

\`\`\`json
{
  "did": ["bullet"],
  "audit": "PASS"
}
\`\`\`

## END SUFFIX

## Trailing iteration notes — must be stripped.
`;

let sandbox: string;
let promptsDir: string;

const VARS: WorkerPromptVars = {
  projectName: 'symphony',
  worktreePath: '/wt/w-abc',
  featureIntent: 'fix the play bar',
  autonomyTier: '2',
  siblingWorkers: '- other thing — /wt/w-xyz',
  negativeConstraints: 'no new deps',
  definitionOfDone: 'tests green',
  testCmd: 'pnpm test',
  buildCmd: 'pnpm build',
  lintCmd: 'pnpm lint',
  previewCmd: 'pnpm dev',
};

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-worker-prompt-'));
  promptsDir = join(sandbox, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  for (const role of WORKER_ROLES) {
    writeFileSync(
      join(promptsDir, `role-opener-${role}-v1.md`),
      openerFixture(role),
      'utf8',
    );
  }
  writeFileSync(
    join(promptsDir, 'worker-common-suffix-v1.md'),
    SUFFIX_FIXTURE,
    'utf8',
  );
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('composeWorkerPrompt', () => {
  it('composes opener + suffix + task for every WorkerRole', () => {
    for (const role of WORKER_ROLES) {
      const out = composeWorkerPrompt(role, 'do the thing', VARS, {
        promptsDir,
      });
      expect(out).toContain(`## Your Role: ${role}`);
      expect(out).toContain('You work in: /wt/w-abc');
      expect(out).toContain('# Your Task\n\ndo the thing');
    }
  });

  it('substitutes all 11 documented template variables', () => {
    const out = composeWorkerPrompt(role(), 'task', VARS, { promptsDir });
    expect(out).toContain('You work in: /wt/w-abc');
    expect(out).toContain('Project: symphony');
    expect(out).toContain('Feature intent: fix the play bar');
    expect(out).toContain('Autonomy tier: 2');
    expect(out).toContain('- other thing — /wt/w-xyz');
    expect(out).toContain('no new deps');
    expect(out).toContain('tests green');
    expect(out).toContain('Build: pnpm build · Lint: pnpm lint · Preview: pnpm dev');
    // opener-region substitution (real reviewer opener references {test_cmd})
    expect(out).toContain('Re-run pnpm test yourself.');
  });

  it('renders empty/blank values as the literal "(none)" sentinel', () => {
    const out = composeWorkerPrompt(
      role(),
      'task',
      {
        ...VARS,
        negativeConstraints: '',
        definitionOfDone: '   ',
        siblingWorkers: '',
      },
      { promptsDir },
    );
    expect(out).toContain('### Negative Constraints\n(none)');
    expect(out).toContain('### Definition of Done\n(none)');
    expect(out).toContain('### Siblings\n(none)');
    expect(out).not.toContain('undefined');
  });

  it('strips opener meta-header and suffix meta — BEGIN/END + first-HR only', () => {
    const out = composeWorkerPrompt(role(), 'task', VARS, { promptsDir });
    expect(out).not.toContain('META NOTE');
    expect(out).not.toContain('Role Opener —');
    expect(out).not.toContain('Template variables');
    expect(out).not.toContain('## BEGIN SUFFIX');
    expect(out).not.toContain('## END SUFFIX');
    expect(out).not.toContain('Trailing iteration notes');
  });

  it('does NOT touch JSON-shaped braces in the reporting block', () => {
    const out = composeWorkerPrompt(role(), 'task', VARS, { promptsDir });
    expect(out).toContain('{\n  "did": ["bullet"],\n  "audit": "PASS"\n}');
  });

  it('leaves unknown {tokens} literal', () => {
    const out = composeWorkerPrompt(role(), 'task', VARS, { promptsDir });
    expect(out).toContain('Unknown token stays literal: {not_a_real_token}');
  });

  it('appends the task verbatim — never substitutes inside the task block', () => {
    const out = composeWorkerPrompt(
      role(),
      'use {lint_cmd} and {project_name} literally here',
      VARS,
      { promptsDir },
    );
    expect(out).toContain(
      '# Your Task\n\nuse {lint_cmd} and {project_name} literally here',
    );
    // sanity: the frozen region still substituted the same tokens
    expect(out).toContain('Project: symphony');
  });

  it('extracts correctly from CRLF artifacts', () => {
    const crlf = join(sandbox, 'crlf');
    mkdirSync(crlf, { recursive: true });
    writeFileSync(
      join(crlf, 'role-opener-implementer-v1.md'),
      openerFixture('Implementer').replace(/\n/g, '\r\n'),
      'utf8',
    );
    writeFileSync(
      join(crlf, 'worker-common-suffix-v1.md'),
      SUFFIX_FIXTURE.replace(/\n/g, '\r\n'),
      'utf8',
    );
    const out = composeWorkerPrompt('implementer', 'task', VARS, {
      promptsDir: crlf,
    });
    expect(out).toContain('## Your Role: Implementer');
    expect(out).toContain('Project: symphony');
    expect(out).not.toContain('META NOTE');
    expect(out).not.toContain('## BEGIN SUFFIX');
  });

  it('throws WorkerPromptLoadError for an unknown role (before any fs access)', () => {
    expect(() =>
      composeWorkerPrompt(
        'saboteur' as unknown as (typeof WORKER_ROLES)[number],
        'task',
        VARS,
        { promptsDir },
      ),
    ).toThrow(WorkerPromptLoadError);
  });

  it('throws WorkerPromptLoadError when the suffix file is missing', () => {
    rmSync(join(promptsDir, 'worker-common-suffix-v1.md'));
    expect(() =>
      composeWorkerPrompt(role(), 'task', VARS, { promptsDir }),
    ).toThrow(WorkerPromptLoadError);
  });

  it('throws WorkerPromptLoadError when SUFFIX markers are absent', () => {
    writeFileSync(
      join(promptsDir, 'worker-common-suffix-v1.md'),
      'No markers here.\n',
      'utf8',
    );
    expect(() =>
      composeWorkerPrompt(role(), 'task', VARS, { promptsDir }),
    ).toThrow(/BEGIN SUFFIX.*END SUFFIX/);
  });

  it('throws WorkerPromptLoadError when an opener has no --- separator', () => {
    writeFileSync(
      join(promptsDir, 'role-opener-planner-v1.md'),
      '# Role Opener — Planner\n\nNo horizontal rule at all.\n',
      'utf8',
    );
    expect(() =>
      composeWorkerPrompt('planner', 'task', VARS, { promptsDir }),
    ).toThrow(/separator/);
  });
});

// Guard against marker/structure drift between the COMMITTED frozen v1
// artifacts and the composer (no promptsDir override → real files).
describe('composeWorkerPrompt against real frozen artifacts', () => {
  const realVars: WorkerPromptVars = {
    projectName: 'symphony',
    worktreePath: '/wt/w-real',
    featureIntent: 'real intent',
    autonomyTier: '1',
    siblingWorkers: '',
    negativeConstraints: '',
    definitionOfDone: '',
    testCmd: 'pnpm test',
    buildCmd: 'pnpm build',
    lintCmd: 'pnpm lint',
    previewCmd: '',
  };

  it('produces a researcher prompt with the read-only fence + reporting contract', () => {
    const out = composeWorkerPrompt('researcher', 'investigate X', realVars);
    expect(out).toContain('## Your Role: Researcher');
    expect(out).toContain('read-only investigator');
    expect(out).toContain('### Reporting Format — MANDATORY');
    expect(out).toContain('"audit": "PASS"');
    // real suffix wraps the token in backticks: `You work in: `<path>``
    expect(out).toMatch(/You work in: .*\/wt\/w-real/);
    expect(out).toContain('# Your Task\n\ninvestigate X');
    // meta-commentary fences stripped from both artifacts
    expect(out).not.toContain('## BEGIN SUFFIX');
    expect(out).not.toContain('Prepends to');
    expect(out).not.toContain('{worktree_path}');
  });

  it('resolves every WorkerRole opener filename on disk', () => {
    for (const r of WORKER_ROLES) {
      const out = composeWorkerPrompt(r, 'task', realVars);
      expect(out).toContain('## Your Role:');
      expect(out).toContain('# Your Task');
    }
  });
});

// Phase 4A M1 fix — the load/preflight seam. `doSpawn` calls
// loadWorkerPromptArtifacts BEFORE worktreeManager.create() so a broken
// bundle / unknown role fast-fails before any worktree exists, then
// threads the validated artifacts into composeWorkerPrompt (no second
// read, no TOCTOU).
describe('loadWorkerPromptArtifacts (preflight seam)', () => {
  it('returns marker-extracted opener + suffix for a role', () => {
    const a = loadWorkerPromptArtifacts('implementer', { promptsDir });
    expect(a.opener).toContain('## Your Role: implementer');
    expect(a.opener).not.toContain('META NOTE');
    expect(a.suffix).toContain('You work in: {worktree_path}');
    expect(a.suffix).not.toContain('## BEGIN SUFFIX');
  });

  it('throws WorkerPromptLoadError on a missing prompts dir (broken bundle)', () => {
    expect(() =>
      loadWorkerPromptArtifacts('implementer', {
        promptsDir: join(sandbox, 'does-not-exist'),
      }),
    ).toThrow(WorkerPromptLoadError);
  });

  it('throws on unknown role BEFORE any filesystem access', () => {
    expect(() =>
      loadWorkerPromptArtifacts(
        'saboteur' as unknown as (typeof WORKER_ROLES)[number],
        { promptsDir },
      ),
    ).toThrow(WorkerPromptLoadError);
  });

  it('composeWorkerPrompt with {preloaded} does NOT touch the filesystem', () => {
    const preloaded = loadWorkerPromptArtifacts('reviewer', { promptsDir });
    // Bogus promptsDir + no fs: must still compose from the preloaded
    // artifacts (proves preloaded short-circuits the read entirely —
    // the no-double-read / same-artifacts-validated-as-rendered prop).
    const out = composeWorkerPrompt('reviewer', 'audit it', VARS, {
      promptsDir: '/definitely/not/here',
      preloaded,
    });
    expect(out).toContain('## Your Role: reviewer');
    expect(out).toContain('# Your Task\n\naudit it');
  });

  it('composeWorkerPrompt without preloaded still loads from disk (regression)', () => {
    const out = composeWorkerPrompt('planner', 'plan it', VARS, { promptsDir });
    expect(out).toContain('## Your Role: planner');
    expect(out).toContain('# Your Task\n\nplan it');
  });
});

describe('resolveWorkerPromptsDir', () => {
  it('honors an explicit override', () => {
    expect(resolveWorkerPromptsDir(import.meta.url, '/explicit/path')).toBe(
      '/explicit/path',
    );
  });

  it('resolves the real repo research/prompts dir from source layout', () => {
    // No override → walks the src/workers candidate. The frozen v1
    // artifacts are committed, so this must succeed in the repo.
    const dir = resolveWorkerPromptsDir();
    expect(dir.replace(/\\/g, '/')).toContain('research/prompts');
  });
});

// The composer signature requires a concrete role; default to implementer
// for the single-role assertions above.
function role(): (typeof WORKER_ROLES)[number] {
  return 'implementer';
}
