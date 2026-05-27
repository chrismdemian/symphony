# Phase 5E + 5F — Production scenario: cross-project saga + TUI filter chip

## Given

- Two real git project directories at `<sandbox>/projA/` and `<sandbox>/projB/`,
  each with `git init` + initial commit.
- A real on-disk SQLite DB (so the new migration 0010 + saga stores are exercised
  end-to-end).
- Both projects registered via `SqliteProjectStore.register`.
- A live `startOrchestratorServer` with `defaultProjectPath = projA`, real
  `SqliteProjectStore` / `SqliteTaskStore` / `SqliteSagaStore`, and the rollup
  listener composed onto the task store's `onTaskStatusChange`.

## When

A user-style cross-project intent unfolds:

1. The user (via Maestro) calls `create_saga(description="ship X across A+B",
   members=[{project:"proja", task_description:"do A side"},
   {project:"projb", task_description:"do B side"}])`.
2. The user calls `update_task(task_id=<A>, status="in_progress")` to start the
   A-side member, then immediately `update_task(task_id=<A>, status="completed")`.
3. The user calls `update_task(task_id=<B>, status="in_progress")` (B still incomplete).
4. The user calls `get_saga(saga_id=<S>)` to read rollup status.
5. The user calls `update_task(task_id=<B>, status="completed")` to close the
   last member.
6. The user calls `get_saga(saga_id=<S>)` again to read terminal status.
7. The user calls `list_sagas(project="projb")` and `list_sagas(status="completed")`
   to confirm membership + status filters.

## Then

1. **After step 1** — `create_saga` returns `isError: false`. Structured content
   carries `saga.id` matching `/^sg-[0-9a-f]{8}$/`, two member rows (one per
   project), and both member tasks land in the task store with `status="pending"`.
2. **After step 2** — saga rolls up to `in_progress` (one member in_progress
   then completed, other still pending). After completion of the A-side, saga
   stays `in_progress` because B is still pending.
3. **After step 3** — saga stays `in_progress` (one completed, one in_progress).
4. **After step 4** — `get_saga` reports `status="in_progress"` with members in
   `[completed, in_progress]` status mix.
5. **After step 5** — rollup writer flips the saga to `completed`. `completedAt`
   is stamped.
6. **After step 6** — `get_saga` reports `status="completed"` and surfaces all
   members in `completed` state.
7. **After step 7** — `list_sagas(project="projb")` returns the saga (membership
   filter); `list_sagas(status="completed")` returns the saga (status filter).
8. **End-state** — the SQLite `sagas` table has one row with `status="completed"`;
   the `saga_members` table has 2 rows; the rollup listener fired exactly the
   transitions the state machine permits (pending → in_progress → completed).

## Notes

- Single-test scenario; exercises the full chain from MCP tool call → SagaStore →
  TaskStore → rollup listener → SagaStore round-trip.
- The 5F filter chip (TUI surface) is exercised by the StatusBar unit tests
  (`tests/ui/StatusBar.filter-chip.test.tsx`) and the integration test (this
  scenario stays orchestrator-side for production-shape parity with 5D).
- The finalize-gate scenario is covered by the unit test
  `tests/orchestrator/tools/finalize-saga-gate.unit.test.ts` — exercising it
  end-to-end requires booting `claude -p` which exceeds the scenario budget.
