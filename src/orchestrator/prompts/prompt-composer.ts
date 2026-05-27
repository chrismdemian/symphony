import path from 'node:path';
import fs from 'node:fs';

import type { WorkerRole } from '../types.js';
import {
  extractPromptBody,
  resolveMaestroPromptsDir,
  substituteMaestroVars,
  type MaestroPromptVars,
} from '../maestro/prompt-composer.js';
import {
  extractAfterFirstHr,
  extractBetween,
  substituteWorkerVars,
  SUFFIX_BEGIN_MARKER,
  SUFFIX_END_MARKER,
  WORKER_ROLE_OPENER_FILES,
  WORKER_SUFFIX_FILENAME,
  type WorkerPromptVars,
} from '../../workers/prompt-composer.js';

/**
 * Phase 4D.1 — fragment-based prompt composition.
 *
 * The frozen v1 artifacts in `research/prompts/` stay authoritative and
 * unedited (Build Philosophy: editing them is forbidden; PLAN.md §4D:
 * "Do NOT re-derive from the design doc"). 4D.1 decomposes them into
 * one `.md` file per section under `research/prompts/fragments/` and
 * builds `PromptComposer`, which re-assembles those fragments and
 * substitutes template variables.
 *
 * The decomposition is PURELY POSITIONAL — the Maestro body is split on
 * the canonical `\n\n---\n\n` section separator; worker fragments are the
 * already-extracted role opener + common suffix. `PromptComposer` reuses
 * the EXACT extraction + substitution helpers the monolith composers
 * ship (`extractPromptBody` / `substituteMaestroVars` /
 * `extractAfterFirstHr` / `extractBetween` / `substituteWorkerVars`), so
 * fragment-assembled output is provably byte-identical to
 * `composeMaestroPrompt` / `composeWorkerPrompt`. The equivalence test
 * (`tests/orchestrator/prompt-composer.unit.test.ts`) locks this forever.
 *
 * Regenerate fragments after any v1 edit: `pnpm gen:fragments`.
 */

/** Canonical section separator in the Maestro v1 body. */
export const MAESTRO_FRAGMENT_SEPARATOR = '\n\n---\n\n';

/**
 * Ordered manifest — index = position in the assembled Maestro body.
 * Generation slices `extractPromptBody(v1)` on
 * {@link MAESTRO_FRAGMENT_SEPARATOR}; composition joins these files back
 * with the same separator. The generator + equivalence test assert
 * `split.length === MAESTRO_FRAGMENT_FILES.length` AND
 * `join === extractPromptBody(v1)`, so a v1 edit that changes the
 * section count fails loudly until this manifest + `pnpm gen:fragments`
 * are updated together. Names follow PLAN.md §4D.1 where listed; the
 * five sections the PLAN's 9-name list omitted (model-selection,
 * escalation/ask-user, interrupts, scope-discipline, vocabulary,
 * rules-summary) get descriptive names — byte-fidelity requires every
 * section, and "plan items are starting points, not full specs".
 */
export const MAESTRO_FRAGMENT_FILES = [
  'maestro-identity.md',
  // Phase 5D — active-project routing protocol. Sits between identity
  // (which surfaces the cursor at session start) and voice (which is
  // about HOW Maestro speaks) because routing is a structural concern
  // that shapes every subsequent tool dispatch.
  'maestro-active-project.md',
  // Phase 5E — cross-project saga protocol. Sits between active-project
  // (single-project routing) and voice (HOW Maestro speaks) because
  // cross-project coordination is also a structural routing concern.
  'maestro-cross-project-saga.md',
  'maestro-voice.md',
  'maestro-autonomy-tiers.md',
  'maestro-model-selection.md',
  'maestro-mode-machine.md',
  'maestro-progress-ledger.md',
  'maestro-delegation-contract.md',
  'maestro-finalize.md',
  // Phase 4G.1 — new audit-loop fragment (rule #9 iterate-in-place).
  // Sits between finalize and escalation per the v1 ordering.
  'maestro-audit-loop.md',
  // Phase 4G.2 — UI verification fragment (verify_ui + skeptical UI
  // reviewer). Sits between audit-loop and escalation.
  'maestro-ui-verification.md',
  'maestro-escalation.md',
  'maestro-interrupts.md',
  'maestro-context-hygiene.md',
  'maestro-scope-discipline.md',
  'maestro-vocabulary.md',
  'maestro-rules-summary.md',
] as const;

/** Role → opener fragment filename (the extracted `## Your Role:` body). */
export const WORKER_ROLE_FRAGMENT_FILES: Readonly<Record<WorkerRole, string>> = {
  implementer: 'worker-role-implementer.md',
  researcher: 'worker-role-researcher.md',
  reviewer: 'worker-role-reviewer.md',
  debugger: 'worker-role-debugger.md',
  planner: 'worker-role-planner.md',
};

/** The extracted common-suffix fragment filename. */
export const WORKER_COMMON_SUFFIX_FRAGMENT = 'worker-common-suffix.md';

/** Header that opens a worker's stdin task kickoff. */
export const WORKER_TASK_HEADER = '# Your Task';

/**
 * Verbatim staleness guard (PLAN.md §4D.2 / worker-common-suffix-v1.md
 * line 102). Prepended to a worker's kickoff message when it is being
 * dispatched into a worktree Symphony already wrote a CLAUDE.md into
 * (reuse across task iterations). Kept exported + as one constant so the
 * 4D.2 injector and any test reference the SAME bytes.
 */
export const NEW_TASK_GUARD =
  '[NEW TASK] You must respond to THIS task, not any previous ones in this worktree.';

export class PromptFragmentLoadError extends Error {
  constructor(
    message: string,
    public readonly file: string,
  ) {
    super(message);
    this.name = 'PromptFragmentLoadError';
  }
}

export interface PromptComposerOptions {
  /**
   * Explicit fragments directory. Tests pass this to keep filesystem
   * resolution off the critical path. Wins over {@link promptsDir}.
   */
  readonly fragmentsDir?: string;
  /**
   * Override the prompts dir whose `fragments/` subdir is used. Defaults
   * to {@link resolveMaestroPromptsDir} (research/prompts in source runs,
   * dist/prompts in the tsup bundle — `tsup.config.ts` copies the
   * `fragments/` subtree alongside).
   */
  readonly promptsDir?: string;
}

/**
 * Resolve the directory holding the generated fragment `.md` files.
 * `<promptsDir>/fragments` — source: `research/prompts/fragments`,
 * bundled: `dist/prompts/fragments`.
 */
export function resolveFragmentsDir(promptsDir?: string): string {
  return path.join(promptsDir ?? resolveMaestroPromptsDir(), 'fragments');
}

/**
 * Assembles Maestro + worker prompts from the generated fragments. One
 * instance is cheap (no I/O until a `compose*` call); construct per
 * spawn or hold a singleton — fragment reads are sync + tiny.
 */
export class PromptComposer {
  private readonly fragmentsDir: string;

  constructor(options: PromptComposerOptions = {}) {
    this.fragmentsDir =
      options.fragmentsDir ?? resolveFragmentsDir(options.promptsDir);
  }

  private read(name: string): string {
    const file = path.join(this.fragmentsDir, name);
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new PromptFragmentLoadError(
        `failed to read prompt fragment '${name}' at ${file}: ${(err as Error).message}. ` +
          'Run `pnpm gen:fragments` to (re)generate fragments from research/prompts/*-v1.md, ' +
          'or `pnpm build` to populate dist/prompts/fragments/.',
        file,
      );
    }
  }

  /**
   * Fast-fail seam: validate the role's fragment files are present +
   * readable WITHOUT composing (no vars needed — fragment reads are
   * var-independent). `worker-lifecycle.doSpawn` calls this in the
   * fast-fail-BEFORE-`worktreeManager.create()` region so a broken
   * bundle (missing `dist/prompts/fragments/`) or unknown role never
   * leaks a worktree per spawn — the fragment-edition of the 4A audit-M1
   * invariant.
   */
  preflightWorker(role: WorkerRole): void {
    const openerFile = WORKER_ROLE_FRAGMENT_FILES[role];
    if (openerFile === undefined) {
      throw new PromptFragmentLoadError(
        `unknown worker role '${String(role)}'; expected one of: ${Object.keys(
          WORKER_ROLE_FRAGMENT_FILES,
        ).join(', ')}`,
        '',
      );
    }
    this.read(openerFile);
    this.read(WORKER_COMMON_SUFFIX_FRAGMENT);
  }

  /**
   * Assemble + substitute the full Maestro system prompt. Byte-identical
   * to `composeMaestroPrompt(vars)` (equivalence-tested).
   */
  composeMaestro(vars: MaestroPromptVars): string {
    const body = MAESTRO_FRAGMENT_FILES.map((n) => this.read(n)).join(
      MAESTRO_FRAGMENT_SEPARATOR,
    );
    return substituteMaestroVars(body, vars);
  }

  /**
   * The worker "operating manual": role opener + common suffix, template
   * variables substituted. Phase 4D.2 writes this into the worker's
   * worktree as `CLAUDE.md` (Multica pattern — Claude Code discovers it
   * natively, cheaper context than re-sending it on every stdin turn).
   *
   * Equals the substituted region of `composeWorkerPrompt` (everything
   * before the appended `# Your Task` block).
   */
  composeWorkerManual(role: WorkerRole, vars: WorkerPromptVars): string {
    const openerFile = WORKER_ROLE_FRAGMENT_FILES[role];
    if (openerFile === undefined) {
      throw new PromptFragmentLoadError(
        `unknown worker role '${String(role)}'; expected one of: ${Object.keys(
          WORKER_ROLE_FRAGMENT_FILES,
        ).join(', ')}`,
        '',
      );
    }
    const opener = this.read(openerFile);
    const suffix = this.read(WORKER_COMMON_SUFFIX_FRAGMENT);
    return substituteWorkerVars(`${opener}\n${suffix}`, vars);
  }

  /**
   * The worker's first stdin message. Phase 4D.2 keeps the TASK on stdin
   * while the manual rides in the worktree `CLAUDE.md`. `staleWorktree`
   * prepends the verbatim {@link NEW_TASK_GUARD} so a reused worktree's
   * leftover context can't confuse the worker.
   *
   * `<task>` is appended VERBATIM (never variable-substituted) so a
   * literal `{token}` inside a brief survives — mirrors
   * `composeWorkerPrompt`'s post-substitution append.
   */
  composeWorkerTaskKickoff(
    taskDescription: string,
    options: { staleWorktree?: boolean; additionalNote?: string } = {},
  ): string {
    // Phase 4F.3 — `additionalNote` is the auto-load slot (rule #13:
    // implementers on a project with DESIGN.md get a one-line nudge
    // appended to the kickoff). NOT a fragment edit (byte-fidelity
    // locked); per-spawn note that's invisible to non-implementer /
    // non-DESIGN.md callers.
    const note =
      options.additionalNote !== undefined &&
      options.additionalNote.trim().length > 0
        ? `\n${options.additionalNote.trim()}\n`
        : '';
    const body = `${WORKER_TASK_HEADER}\n\n${taskDescription.trim()}\n${note}`;
    return options.staleWorktree === true
      ? `${NEW_TASK_GUARD}\n\n${body}`
      : body;
  }

  /**
   * Full monolithic worker prompt (manual + `\n\n---\n\n` + task kickoff).
   * Byte-identical to `composeWorkerPrompt(role, task, vars, {})`
   * (equivalence-tested). 4D.2 splits manual vs kickoff instead; this is
   * kept for the equivalence oracle and any caller wanting one string.
   */
  composeWorker(
    role: WorkerRole,
    taskDescription: string,
    vars: WorkerPromptVars,
    options: { additionalNote?: string } = {},
  ): string {
    // `additionalNote` is forwarded to the kickoff (Phase 4F.3 DESIGN.md
    // auto-load). The byte-equivalence test calls this with no
    // additionalNote, so byte-identity with `composeWorkerPrompt`
    // (the frozen 4A monolith) is preserved in that path.
    const kickoffOpts =
      options.additionalNote !== undefined
        ? { additionalNote: options.additionalNote }
        : {};
    return (
      this.composeWorkerManual(role, vars) +
      MAESTRO_FRAGMENT_SEPARATOR +
      this.composeWorkerTaskKickoff(taskDescription, kickoffOpts)
    );
  }

  /**
   * Phase 4F.1 — fast-fail seam for a CUSTOM DROID spawn. The droid
   * body is already in memory (resolved from the registry in the
   * spawn-worker handler), so the only fs-touching fragment is the
   * common suffix. Called by `doSpawn` in the
   * fast-fail-BEFORE-`worktreeManager.create()` region — same
   * no-leaked-worktree invariant as {@link preflightWorker}, minus the
   * role-opener file (a droid has none; its opener IS its body).
   */
  preflightCustomDroid(): void {
    this.read(WORKER_COMMON_SUFFIX_FRAGMENT);
  }

  /**
   * Phase 4F.1 — the worker "operating manual" for a custom droid:
   * `<droid body>` substituted in place of a built-in role opener,
   * followed by the SAME common suffix + the SAME `substituteWorkerVars`
   * the built-in path uses. Reusing the suffix verbatim is deliberate:
   * the Phase 4E structured-completion contract lives there, so a
   * custom droid inherits it for free (Maestro reads its completion the
   * same way it reads any worker's). Built-in composition is untouched
   * — this is purely additive (byte-fidelity tests cover only the 5
   * built-in roles + Maestro and are unaffected).
   */
  composeCustomDroidManual(
    droidBody: string,
    vars: WorkerPromptVars,
  ): string {
    const suffix = this.read(WORKER_COMMON_SUFFIX_FRAGMENT);
    return substituteWorkerVars(`${droidBody}\n${suffix}`, vars);
  }

  /**
   * Full monolithic custom-droid prompt (manual + separator + task
   * kickoff). The stdin-fallback twin of {@link composeWorker} for the
   * custom-droid path — used when `injectWorkerClaudeMd` can't place a
   * worktree CLAUDE.md (project tracks its own / non-worktree / fs
   * error), exactly mirroring the built-in fallback.
   */
  composeCustomDroidWorker(
    droidBody: string,
    taskDescription: string,
    vars: WorkerPromptVars,
  ): string {
    return (
      this.composeCustomDroidManual(droidBody, vars) +
      MAESTRO_FRAGMENT_SEPARATOR +
      this.composeWorkerTaskKickoff(taskDescription)
    );
  }
}

export interface GeneratedFragment {
  readonly file: string;
  readonly content: string;
}

/**
 * PURE — derive every fragment file's content from the frozen v1
 * artifacts in `promptsDir`. The one source of truth for the
 * decomposition: `pnpm gen:fragments` writes these to
 * `research/prompts/fragments/`; the equivalence test re-derives and
 * asserts the on-disk fragments match (drift guard) AND that a
 * `PromptComposer` over them reproduces the monolith composers exactly.
 *
 * Throws `PromptFragmentLoadError` if the Maestro v1 splits into a
 * different number of sections than {@link MAESTRO_FRAGMENT_FILES}, or
 * if the split is not separator-faithful (rejoin must equal the body).
 */
export function generateFragmentsFromV1(promptsDir: string): GeneratedFragment[] {
  const out: GeneratedFragment[] = [];

  const maestroV1File = path.join(promptsDir, 'maestro-system-prompt-v1.md');
  const maestroRaw = fs.readFileSync(maestroV1File, 'utf8');
  const body = extractPromptBody(maestroRaw, maestroV1File);
  const chunks = body.split(MAESTRO_FRAGMENT_SEPARATOR);
  if (chunks.length !== MAESTRO_FRAGMENT_FILES.length) {
    throw new PromptFragmentLoadError(
      `maestro v1 split into ${chunks.length} sections but MAESTRO_FRAGMENT_FILES ` +
        `has ${MAESTRO_FRAGMENT_FILES.length}. Update the manifest to match the ` +
        'frozen artifact (the v1 file stays authoritative), then re-run.',
      maestroV1File,
    );
  }
  if (chunks.join(MAESTRO_FRAGMENT_SEPARATOR) !== body) {
    throw new PromptFragmentLoadError(
      'maestro v1 split is not separator-faithful (rejoin !== extracted body); ' +
        'a section likely uses a non-canonical separator.',
      maestroV1File,
    );
  }
  MAESTRO_FRAGMENT_FILES.forEach((file, i) => {
    out.push({ file, content: chunks[i]! });
  });

  for (const role of Object.keys(WORKER_ROLE_FRAGMENT_FILES) as WorkerRole[]) {
    const openerV1Name = WORKER_ROLE_OPENER_FILES[role];
    const openerV1File = path.join(promptsDir, openerV1Name);
    const openerRaw = fs.readFileSync(openerV1File, 'utf8');
    out.push({
      file: WORKER_ROLE_FRAGMENT_FILES[role],
      content: extractAfterFirstHr(openerRaw, openerV1File),
    });
  }

  const suffixV1File = path.join(promptsDir, WORKER_SUFFIX_FILENAME);
  const suffixRaw = fs.readFileSync(suffixV1File, 'utf8');
  out.push({
    file: WORKER_COMMON_SUFFIX_FRAGMENT,
    content: extractBetween(
      suffixRaw,
      SUFFIX_BEGIN_MARKER,
      SUFFIX_END_MARKER,
      suffixV1File,
    ),
  });

  return out;
}
