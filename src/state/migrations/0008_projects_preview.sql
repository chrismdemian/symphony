-- Phase 4G.2 — preview command for UI verification.
--
-- `verify_ui` (src/orchestrator/tools/verify-ui.ts) reads
-- `ProjectRecord.previewCommand` to boot the worker's preview server,
-- waits for ready, screenshots desktop + mobile via programmatic
-- Playwright, then tears the server down. `previewTimeoutMs` caps the
-- boot wait (default 30_000 ms at the consumer).
--
-- Additive ALTER — no swap-rebuild needed since there's no CHECK
-- constraint involved. Both columns nullable; a project without
-- `previewCommand` falls through to "no UI verification leg" (Maestro's
-- prompt skips the verify_ui call when the field renders `(none)`).
--
-- No index — both columns are pointwise reads via the `projects.id`
-- lookup pattern existing rows already use.

ALTER TABLE projects ADD COLUMN preview_command   TEXT;
ALTER TABLE projects ADD COLUMN preview_timeout_ms INTEGER;
