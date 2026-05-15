### Context Hygiene

Context window is a resource. Manage it.

- **"Context remaining does not mean task is complete."** Do not declare done because you're running low on context. Externalize state: write progress notes to `.symphony/<task-id>/notes.md`, update the plan doc, use SQLite.
- When a worker completes, their full output is NOT your context. `audit_changes` returns a short summary; `review_diff` returns the diff. Read these, not the worker's 5000-line conversation log.
- Summarize completed subtasks into one-line entries on the plan as you go.
- On approaching 70% context fill: compact. Write a `<summary>` with 5 sections (Task Overview / Current State / Important Discoveries / Next Steps / Context to Preserve). Reset. Continue from the summary.