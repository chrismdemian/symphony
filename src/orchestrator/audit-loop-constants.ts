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

/**
 * Phase 5E — verbatim cross-project saga protocol Maestro follows when
 * the USER's request explicitly names 2+ registered projects. Quoted in
 * the v1 prompt's Cross-Project Sagas section (regenerated as fragment
 * `maestro-cross-project-saga.md`). Drift-locked 4-ways against the
 * fragment AND the regenerated v1 monolith AND the four saga MCP tool
 * names (`create_saga`/`update_saga`/`list_sagas`/`get_saga`) AND the
 * `force_saga_partial` finalize input flag by
 * `tests/integration/5e-prompt-drift.integration.test.ts`.
 *
 * Renaming any of those four tools OR the finalize flag requires editing
 * this constant + the v1 prompt + `pnpm gen:fragments`; the drift-lock
 * test fails CI otherwise. Mirrors the 5D `ACTIVE_PROJECT_PROTOCOL`
 * pattern, with one extra lock direction for the finalize input flag.
 */
export const CROSS_PROJECT_SAGA_PROTOCOL =
  '**When to create a saga.** Two and only two conditions BOTH have to hold:\n\n1. The USER\'s request as stated REQUIRES coordinated changes in 2+ distinct registered projects. A single-project change with cross-cutting reasoning ("update the API — also make sure the docstring matches the new client behavior") is NOT cross-project; it\'s one task in one project.\n2. Failure of ANY member should NOT ship the others. The saga\'s value is the saga-partial gate: if A succeeds and B fails, A is held back. If shipping A independently of B\'s outcome is fine, you don\'t need a saga — bare `create_task` per project is the right shape.';

/**
 * Phase 5E — verbatim "saga creation + immutability" block Maestro
 * must follow. Drift-locked alongside `CROSS_PROJECT_SAGA_PROTOCOL`.
 * Splitting the protocol into multiple constants keeps each one
 * checkable as a substring without making any single string unwieldy.
 *
 * Mirrors `audit-loop-constants` 5C / 5D pattern: each constant is a
 * paragraph (or two) the drift-lock test asserts as a verbatim substring
 * of both fragment + monolith.
 */
export const CROSS_PROJECT_SAGA_CREATION =
  '**Saga creation.** Once both conditions hold, call `create_saga(description, members[])` with:';

/**
 * Phase 5E — verbatim "monitoring + rollup" rules. Locks the wire
 * strings Maestro consults when polling saga progress.
 */
export const CROSS_PROJECT_SAGA_MONITORING =
  '**Monitoring.** Poll `get_saga(saga_id)` while members are in flight (NOT every tick — sample at meaningful boundaries: worker completion, errors, USER status probe). The saga rollup writer automatically transitions the saga as members transition:';

/**
 * Phase 5E — verbatim "finalize gate response" rules. The two correct
 * responses to a `saga-partial` code: wait vs explicit USER-confirmed
 * abandon. This is the load-bearing safety guidance — if a future
 * edit drops the "Default to waiting" line, the drift-lock catches it.
 */
export const CROSS_PROJECT_SAGA_GATE_RESPONSES =
  'Default to waiting. `force_saga_partial` is the escape hatch, not the workflow.';

/**
 * Phase 5E — verbatim sentinel string referenced by the finalize gate
 * + the saga protocol fragment. Drift-locked against the `finalize.ts`
 * Zod schema flag name. Renaming the flag requires editing this
 * constant + the schema + the v1 prompt + `pnpm gen:fragments`.
 */
export const FORCE_SAGA_PARTIAL_FLAG_NAME = 'force_saga_partial';

/**
 * Phase 5E — verbatim structured-content code Symphony returns from the
 * saga-partial gate. Drift-locked against the gate's return value AND
 * the protocol fragment's documentation of the code Maestro should
 * pattern-match on. Renaming requires editing this constant + the
 * gate's return + the v1 prompt + `pnpm gen:fragments`.
 */
export const SAGA_PARTIAL_ERROR_CODE = 'saga-partial';


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
