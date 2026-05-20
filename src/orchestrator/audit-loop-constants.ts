/**
 * Phase 4G.1 — audit-loop constants (drift-lock pattern).
 *
 * Maestro's iterate-in-place audit loop is rule #9: after an implementer
 * completes, Maestro calls `audit_changes`. On `verdict: FAIL`, Maestro
 * calls `resume_worker(implementerId, <findings>. Fix and re-run tests.)`
 * and re-audits. The server tracks `auditAttempts` server-side
 * (see `audit-changes.ts:runAudit`'s auto-bump); on the {@link AUDIT_RETRY_CAP}'th
 * FAIL Maestro escalates to the USER with the findings history.
 *
 * The wire strings below are quoted VERBATIM in the Maestro v1 prompt
 * (research/prompts/maestro-system-prompt-v1.md). A drift-lock integration
 * test (`tests/integration/4g1-prompt-drift.integration.test.ts`) imports
 * each constant and asserts the regenerated fragment manifest contains it.
 * Mirrors the 4F.3 `DESIGN_MD_AUTO_LOAD_NOTE` drift-lock pattern
 * (`worker-lifecycle.ts:45`).
 *
 * Editing either side requires editing BOTH the constant AND the v1
 * prompt — `pnpm gen:fragments` regenerates the fragments, and the
 * drift-lock test fails CI if the two diverge.
 */

/**
 * Maximum number of audit FAILs before Maestro escalates the task to
 * the USER. The PLAN.md verification pipeline (§Iteration Loop) caps
 * implementation retries at 3 after review. Counter == 3 means three
 * attempts have failed; Maestro stops iterating and surfaces the
 * findings history.
 *
 * The server tracks the count via `WorkerRegistry.bumpAuditAttempts`;
 * Maestro applies the cap rule by reading `AuditResult.auditAttempts`.
 * The cap is NOT enforced at the dispatch layer — Maestro retains
 * judgment (e.g. for a 4th audit after the USER explicitly asks).
 */
export const AUDIT_RETRY_CAP = 3;

/**
 * Verbatim prefix Maestro prepends to `resume_worker` payloads when
 * sending findings back to a failed implementer (rule #9). Quoted in
 * the Maestro v1 prompt's Audit Loop section. Drift-locked by
 * `tests/integration/4g1-prompt-drift.integration.test.ts`.
 *
 * Maestro composes the full payload as:
 *   `${AUDIT_RESUME_PROMPT_PREFIX}${findingsBlock}. Fix and re-run tests.`
 * where `findingsBlock` is a bullet list of Critical + Major findings.
 */
export const AUDIT_RESUME_PROMPT_PREFIX =
  'Reviewer audit returned FAIL. Findings:\n';

/**
 * Verbatim template Maestro uses to escalate to the USER when
 * `audit_attempts >= ` {@link AUDIT_RETRY_CAP}. Includes the `{attempts}`
 * and `{findings}` placeholders which Maestro substitutes at composition
 * time with the counter value and the latest findings summary. Quoted
 * verbatim in the Maestro v1 prompt's Audit Loop section so the wording
 * stays consistent across runs.
 *
 * The cap reasons over **cumulative** audit attempts, NOT just
 * consecutive FAILs — the counter does not reset on PASS (see prompt
 * fragment `maestro-audit-loop.md` line 32 for the design rationale).
 * A worker whose history is FAIL → PASS → FAIL → FAIL hits the cap at
 * attempts=4 (not 2), which is intentional.
 */
export const AUDIT_ESCALATION_TEMPLATE =
  '{attempts} audit attempts have failed for this task. Latest findings:\n{findings}\nHow should I proceed?';

/**
 * Phase 4G.2 — verbatim task brief Maestro splices the screenshot paths
 * into when spawning a fresh REVIEWER worker for UI verification. The
 * framing comes from `~/CLAUDE.md` (Frontend Design Toolkit / UI Visual
 * Validator): "Default assumption: changes have NOT succeeded. Describe
 * exactly what you observe. Actively search for evidence of failure —
 * misalignment, overflow, broken spacing, wrong colors. Do NOT approve
 * unless everything matches requirements exactly."
 *
 * Maestro composes the full task description by `.replace`-ing the
 * `{desktop_path}`, `{mobile_path}`, and `{requirements}` placeholders
 * with paths from `verify_ui` and a short prose summary of what the
 * implementer was asked to build. The reviewer reads the PNG files via
 * Claude Code's image-capable `Read` tool — no extra image-input
 * plumbing required.
 *
 * Drift-locked against `maestro-ui-verification.md` fragment by
 * `tests/integration/4g2-prompt-drift.integration.test.ts` (mirrors the
 * 4F.3 `DESIGN_MD_AUTO_LOAD_NOTE` and 4G.1 `AUDIT_RESUME_PROMPT_PREFIX`
 * patterns).
 *
 * Reviewer ≠ writer is enforced by the reviewer role opener
 * (`role-opener-reviewer-v1.md:13`); Maestro's prompt MUST spawn a fresh
 * reviewer, NOT `resume_worker` on the implementer.
 */
export const UI_REVIEWER_TASK_BRIEF_TEMPLATE = `You are a skeptical UI reviewer for Symphony.

Screenshots from the implementer's worktree (read each with the Read tool — Claude Code's Read handles PNGs natively):
- Desktop (1280x720): {desktop_path}
- Mobile  (390x844):  {mobile_path}

Visual requirements:
{requirements}

Grading rubric:
- Default assumption: the visual changes have NOT succeeded. You must prove they did.
- Describe exactly what you observe in each screenshot — not what you expect.
- Actively search for evidence of failure: misalignment, overflow, broken spacing, wrong colors, missing elements, illegible text, broken responsive layout, content cut off, hardcoded English in a non-English context, etc.
- Do NOT approve unless every requirement is met exactly. "Looks close" is FAIL.
- Cite the screenshot path + a brief description of the defect for every finding.

Return the standard 8-field JSON completion report. Put Critical and Major visual defects in \`blockers\`. Put Minor defects in \`open_questions\`. \`audit: "PASS"\` ONLY if zero Critical and zero Major findings.`;
