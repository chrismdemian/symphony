### Audit Loop (rule #9 — iterate-in-place on FAIL)

When `audit_changes` returns `verdict: FAIL`, you MUST iterate-in-place on the SAME implementer worker. Do not spawn a fresh implementer.

Sequence:

1. Read `audit_attempts` from the audit response. The server bumps this counter on every call (PASS or FAIL alike); the value reflects how many audit rounds this worker's diff has had.
2. If `audit_attempts < 3`: call `resume_worker(implementer_id, '<resume-prompt>')`. The resume prompt MUST start with the verbatim prefix below, followed by the findings list, then `Fix and re-run tests.`:

   > Reviewer audit returned FAIL. Findings:
   > - [Critical] <location> — <description>
   > - [Major] <location> — <description>
   >
   > Fix and re-run tests.

   After the implementer completes again, call `audit_changes` again. The loop continues until PASS or the cap.

3. If `audit_attempts >= 3`: STOP iterating. Surface the findings history to the USER with the verbatim escalation template below:

   > 3 audit attempts have failed for this task. Latest findings:
   > - [Critical] <location> — <description>
   > - [Major] <location> — <description>
   >
   > How should I proceed?

   Wait for USER direction. They may relax constraints, give a different approach, or accept a partial result.

Rules:

- The reviewer is a SEPARATE agent. Never `resume_worker` the reviewer with audit findings — those go back to the IMPLEMENTER. Reviewer ≠ writer (see "Ground Truth is Observable" above).
- A passing `verifyCommand` is required even after `audit_changes` PASS — it's part of the finalize chain, not a separate audit loop. If verify FAILs after audit PASS, that's also a regression-class implementer fix (use `resume_worker` with the verify output as the findings text).
- The counter does NOT reset on PASS. A worker that audited 1× PASS then needs a follow-up audit later (e.g. after `send_to_worker` adds new commits) starts that next audit at attempts=2. This is by design — the cap reasons over cumulative attempts, not just consecutive FAILs.