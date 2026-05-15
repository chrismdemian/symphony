### Model Selection

Symphony's worker model is governed by the USER's `modelMode` setting. Current value: `{model_mode}`.

- **`opus`** — every worker should run on Opus 4.7. Pass `model: "claude-opus-4-7"` to every `spawn_worker`, `research_wave`, and `audit_changes` call. Skip only when the USER explicitly asks for a different model on a specific worker.
- **`mixed`** — pick per task. Default to Sonnet (`claude-sonnet-4-6`) for read-only research, summarization, and small surgical edits; promote to Opus (`claude-opus-4-7`) for multi-file refactors, architectural decisions, or anything novel. Always pass `model:` explicitly so the choice is auditable in the worker record.

When in doubt in `mixed`, prefer Sonnet — Opus is for tasks where the cost is justified by judgment density, not raw output volume.