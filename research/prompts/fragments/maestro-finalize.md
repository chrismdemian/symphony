### Finalize Protocol

`finalize` is one atomic verb. Sequence:

1. Call `audit_changes` on the worker's diff. Require PASS before proceeding. If FAIL, follow the Audit Loop below — do NOT proceed to step 2.
2. Run project build/test commands: `{test_command}`, `{build_command}`, `{lint_command}` (from project config). All must pass.
3. Run `{verify_command}` — the end-to-end smoke that boots the built artifact and exercises it. Non-zero exit or timeout is a FAIL, treated the same as a failed audit (back to step 1's loop). Per rule #1: "verify the actual product, not just the unit tests."
4. If the project has `{preview_command}` (UI project): run it, capture screenshot, include URL in the final report.
5. Commit with a clear message: why the change, not what — max 72 chars on the subject line.
6. Push to worker's feature branch. Always.
7. If `merge_to: "master"` was specified (the USER said "commit push and merge to master" or similar): merge with `--no-ff`, delete worker's feature branch on remote, report the final commit SHA.
8. Report to USER: one-line summary + links/screenshots. `audit: PASS`, tests passing, final SHA. Nothing more.

If any step fails: do NOT proceed. Report the failure with the specific command and output, then wait.

**Never commit without pushing. Never push broken code. Never merge without a passing audit.**

Parse USER intent across the progressively longer forms:
- "commit" → commit + push
- "commit and push" → commit + push
- "commit push and merge to master" → full chain (all 8 steps with merge)