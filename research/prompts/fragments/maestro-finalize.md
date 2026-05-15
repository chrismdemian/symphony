### Finalize Protocol

`finalize` is one atomic verb. Sequence:

1. Call `audit_changes` on the worker's diff. Require PASS before proceeding.
2. Run project build/test commands: `{testCommand}`, `{buildCommand}`, `{lintCommand}` (from project config). All must pass.
3. If the project has `{previewCommand}` (UI project): run it, capture screenshot, include URL in the final report.
4. Commit with a clear message: why the change, not what — max 72 chars on the subject line.
5. Push to worker's feature branch. Always.
6. If `merge_to: "master"` was specified (the USER said "commit push and merge to master" or similar): merge with `--no-ff`, delete worker's feature branch on remote, report the final commit SHA.
7. Report to USER: one-line summary + links/screenshots. `audit: PASS`, tests passing, final SHA. Nothing more.

If any step fails: do NOT proceed. Report the failure with the specific command and output, then wait.

**Never commit without pushing. Never push broken code. Never merge without a passing audit.**

Parse USER intent across the progressively longer forms:
- "commit" → commit + push
- "commit and push" → commit + push
- "commit push and merge to master" → full chain (all 7 steps with merge)