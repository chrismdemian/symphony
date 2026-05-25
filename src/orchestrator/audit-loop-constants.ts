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
/**
 * Phase 5C — verbatim context-hygiene rule Maestro follows when
 * externalizing progress notes. Quoted in the v1 prompt's Context
 * Hygiene section (and the regenerated fragment
 * `maestro-context-hygiene.md`). Drift-locked against the fragment by
 * `tests/integration/5c-prompt-drift.integration.test.ts` (mirrors the
 * 4F.3 `DESIGN_MD_AUTO_LOAD_NOTE` / 4G.1 `AUDIT_RESUME_PROMPT_PREFIX`
 * / 4G.2 `UI_REVIEWER_TASK_BRIEF_TEMPLATE` patterns).
 *
 * The protocol references the `task_notes` MCP tool by name; Symphony's
 * tool registration in `server.ts:registerTaskNotesTool` is the
 * code-side authority. Renaming the tool requires editing the v1
 * prompt + this constant + `pnpm gen:fragments`; the drift-lock test
 * fails CI otherwise.
 */
export const TASK_NOTES_PROTOCOL =
  '**"Context remaining does not mean task is complete."** Do not declare done because you\'re running low on context. Externalize state: call `task_notes(action: "append", task_id, text)` for every progress beat — Symphony mirrors the SQL row to `<project>/.symphony/tasks/<task-id>/notes.md` so workers spawned for that task can `Read` prior context from their worktree. Pull notes on demand with `task_notes(action: "read", task_id)` (one task, markdown blob — does NOT flood like `list_tasks`). `task_notes(action: "list")` summarizes which tasks have notes worth reading. Update the plan doc. Use SQLite.';

/**
 * Phase 5D — verbatim active-project routing protocol Maestro follows
 * when the USER mentions a project. Quoted in the v1 prompt's Active
 * Project Routing section (regenerated as fragment
 * `maestro-active-project.md`). Drift-locked against the fragment AND
 * the MCP tool name + clear sentinel by
 * `tests/integration/5d-prompt-drift.integration.test.ts` (4-way lock,
 * matching 5C `TASK_NOTES_PROTOCOL`).
 *
 * The protocol references the `set_active_project` MCP tool by name +
 * the `"(none)"` clear sentinel. Symphony's tool registration in
 * `server.ts` and the Zod schema in `tools/set-active-project.ts` are
 * the code-side authorities. Renaming either the tool OR the sentinel
 * requires editing this constant + the v1 prompt + `pnpm gen:fragments`;
 * the drift-lock test fails CI otherwise.
 */
export const ACTIVE_PROJECT_PROTOCOL =
  '**Confident match → switch immediately.** When the USER names a project that resolves unambiguously to one registered entry, call `set_active_project(name)` BEFORE downstream tool calls. The switch persists to `~/.symphony/config.json` (survives restarts) and Symphony emits a chat row confirming the change. You do NOT need to announce the switch separately — the row IS the announcement.';


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
