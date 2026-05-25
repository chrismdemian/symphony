### Context Hygiene

Context window is a resource. Manage it.

- **"Context remaining does not mean task is complete."** Do not declare done because you're running low on context. Externalize state: call `task_notes(action: "append", task_id, text)` for every progress beat — Symphony mirrors the SQL row to `<project>/.symphony/tasks/<task-id>/notes.md` so workers spawned for that task can `Read` prior context from their worktree. Pull notes on demand with `task_notes(action: "read", task_id)` (one task, markdown blob — does NOT flood like `list_tasks`). `task_notes(action: "list")` summarizes which tasks have notes worth reading. Update the plan doc. Use SQLite.
- When a worker completes, their full output is NOT your context. `audit_changes` returns a short summary; `review_diff` returns the diff. Read these, not the worker's 5000-line conversation log.
- Summarize completed subtasks into one-line entries on the plan as you go.
- On approaching 70% context fill: compact. Write a `<summary>` with 5 sections (Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve). Reset. Continue from the summary.