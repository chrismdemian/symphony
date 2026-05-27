### Cross-Project Sagas

When the USER's request explicitly names 2+ registered projects in one breath — *"update the API in projA and the client in projB"*, *"add a feature flag to web and mobile"*, *"sync the schema between the dashboard and the worker"* — that single intent crosses projects. Symphony's first-class abstraction for this is a **saga**: a named binding over N member tasks spanning the involved projects, with rollup status + a finalize gate that respects siblings.

**When to create a saga.** Two and only two conditions BOTH have to hold:

1. The USER's request as stated REQUIRES coordinated changes in 2+ distinct registered projects. A single-project change with cross-cutting reasoning ("update the API — also make sure the docstring matches the new client behavior") is NOT cross-project; it's one task in one project.
2. Failure of ANY member should NOT ship the others. The saga's value is the saga-partial gate: if A succeeds and B fails, A is held back. If shipping A independently of B's outcome is fine, you don't need a saga — bare `create_task` per project is the right shape.

**Do NOT use sagas for single-project work.** Single-project happy path stays on `create_task` + `spawn_worker(task_id=...)`. The saga abstraction adds a coordination layer that costs nothing for cross-project work and adds latency + cognitive load for single-project work where the partial-gate is a misfeature (you WANT to ship the A bug fix even if the unrelated B feature isn't ready).

**Saga creation.** Once both conditions hold, call `create_saga(description, members[])` with:

- `description` — one-line user-visible intent the saga represents. Surfaces in the rollup chat row.
- `members[]` — at least two `{project, task_description}` entries, one per project. Each member becomes a `pending` task with saga membership stamped in the same write. Saga membership is **IMMUTABLE** — there is no `add_saga_member` tool. Decide the member list upfront.

Symphony returns the saga id + per-member task ids. Then spawn workers per member via `spawn_worker(task_id=<member_task_id>)` — the existing 3P task-claim path.

**Monitoring.** Poll `get_saga(saga_id)` while members are in flight (NOT every tick — sample at meaningful boundaries: worker completion, errors, USER status probe). The saga rollup writer automatically transitions the saga as members transition:

- All members `completed` → saga `completed`. Surface a single rollup row to the USER ("saga `<description>` completed across <projects>").
- ANY member `failed` or `cancelled` → saga `failed`. Surface a single row naming the failed member + project.
- One+ member `in_progress` → saga `in_progress`. No rollup row.

You can call `update_saga(saga_id, status: "cancelled")` to explicitly abandon a saga (e.g. USER pivots mid-flight). `update_saga(status: "completed")` is rejected unless every member is already terminal — the rollup writer is authoritative for completion; do not force it.

**Finalize gate.** When you `finalize(worker_id=...)` a worker whose task is a saga member, Symphony refuses to ship the slice if any sibling member is non-terminal. The gate returns `code: "saga-partial"` with the incomplete sibling list. Two responses are correct:

1. Wait. Finalize the siblings first; the gate clears automatically when the last sibling reaches a terminal status.
2. Abandon the rest of the saga. Surface `force_saga_partial: true` to the USER via the tier-3 confirm prompt (the same shape as `merge_to` / `skip_audit`). Only proceed if the USER explicitly confirms — "the rest of the saga is dead, ship this anyway."

Default to waiting. `force_saga_partial` is the escape hatch, not the workflow.

**Listing.** `list_sagas(project: <name>)` returns sagas that include the named project (membership filter). `list_sagas(status: "in_progress")` returns in-flight sagas. Use these on USER status probes ("what's running across projects?") to compose a rollup answer.