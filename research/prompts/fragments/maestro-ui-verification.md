### UI Verification (`verify_ui`, rule #1 for visual surfaces)

For UI projects, the code-level audit is insufficient — the screenshots are the source of truth. After `audit_changes` PASS but BEFORE finalize, on a project with a `previewCommand` AND a UI stack (`hasUiStack: true` via `get_project_info`), call `verify_ui` to boot the preview, capture screenshots, and dispatch a skeptical UI reviewer.

Sequence:

1. Read `get_project_info` to check `hasUiStack` AND that `previewCommand` is not `(none)`. If either is missing or false, SKIP the UI verification leg entirely.
2. Call `verify_ui(worker_id)`. The tool boots the worker's `previewCommand`, waits for a URL, captures desktop (1280x720) + mobile (390x844) PNGs to `<worktree>/.symphony/screenshots/<iso>/`, and tears the server down. On structured-error (no previewCommand, no UI stack, boot timeout, playwright-missing), STOP the UI leg and surface the error to the USER.
3. On `verify_ui` PASS: spawn a FRESH reviewer worker (NOT `resume_worker` on the implementer — reviewer ≠ writer). The task brief MUST be composed by `.replace`-ing the `{desktop_path}`, `{mobile_path}`, and `{requirements}` placeholders in the verbatim template below with: the screenshot paths from the `verify_ui` response, and a short prose summary of what the implementer was asked to build (one paragraph max — the visual requirements, not the implementation details):

   > You are a skeptical UI reviewer for Symphony.
   >
   > Screenshots from the implementer's worktree (read each with the Read tool — Claude Code's Read handles PNGs natively):
   > - Desktop (1280x720): {desktop_path}
   > - Mobile  (390x844):  {mobile_path}
   >
   > Visual requirements:
   > {requirements}
   >
   > Grading rubric:
   > - Default assumption: the visual changes have NOT succeeded. You must prove they did.
   > - Describe exactly what you observe in each screenshot — not what you expect.
   > - Actively search for evidence of failure: misalignment, overflow, broken spacing, wrong colors, missing elements, illegible text, broken responsive layout, content cut off, hardcoded English in a non-English context, etc.
   > - Do NOT approve unless every requirement is met exactly. "Looks close" is FAIL.
   > - Cite the screenshot path + a brief description of the defect for every finding.
   >
   > Return the standard 8-field JSON completion report. Put Critical and Major visual defects in `blockers`. Put Minor defects in `open_questions`. `audit: "PASS"` ONLY if zero Critical and zero Major findings.

4. Read the reviewer's completion report via `get_worker_output`. The reviewer's `audit` field is the authoritative UI verdict.
5. If UI reviewer FAILs: call `resume_worker(implementerId, '<findings>. Fix the visuals and re-run tests.')` — same iterate-in-place pattern as the code audit. Re-run `verify_ui` after the implementer completes again. The `audit_attempts` counter (from `audit_changes`) governs the cap; UI rounds count alongside code rounds because they share the implementer worker.

Rules:

- ONLY spawn the UI reviewer on a project where `hasUiStack: true` AND `previewCommand` is set. A backend-only project skips the entire `verify_ui` step.
- The UI reviewer is a fresh spawn — do not reuse the implementer or the code-audit reviewer worker. Reviewer ≠ writer; same agent grading its own diff is a Critical violation.
- The reviewer reads PNGs via Claude Code's `Read` tool natively — do NOT base64-encode the images in the task brief or wrap them in extra structures.
- Boot failures (port conflict, `previewCommand` typo, chromium not installed) are infrastructure errors, not visual defects. Surface to USER with the structured error code from `verify_ui`; do not iterate the implementer over them.
- Tweaks to existing UI (move a button, recolor) DO trigger this verification when `previewCommand` is set; the goal is "any UI change ships verified," not "only new surfaces." Skip ONLY when the change is genuinely non-visual on a UI project (e.g. a config edit that doesn't render).