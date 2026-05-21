-- Phase 5A — multi-project config foundation.
--
-- Persists the `<project>/.symphony.json` `project` section into the
-- `projects` table so per-project config survives Symphony restart
-- without needing the caller to re-supply `options.projectConfigs` each
-- boot. PLAN.md §Phase 5 (lines 1944–1982) declares these as the source
-- of truth for downstream work: per-project MCP routing (5C), TUI
-- project picker (5F), CLI add/list/remove (5B).
--
-- The Zod schema in `src/worktree/symphony-config.ts` validates value
-- ranges (qualityPipeline ∈ {full,simplified,none}; defaultAutonomyTier
-- ∈ {1,2,3}; maestroWarmth ∈ [0,1]). SQL columns are nullable + uncheck'd
-- so the migration stays additive — no swap-rebuild needed. Matches the
-- 0008 template; future migrations that DO swap-rebuild `projects` MUST
-- carry these 9 columns forward in their `projects_new` column list
-- (see Phase 4G.2 gotcha + Phase 3T migration 0005 caveat).
--
-- `plan_mode_required` is INTEGER (0/1) — SQLite has no native boolean.
-- Round-trip in `SqliteProjectStore.rowToRecord` converts to TS boolean.
--
-- No index — all reads are pointwise via `projects.id` lookup.

ALTER TABLE projects ADD COLUMN worktree_dir          TEXT;
ALTER TABLE projects ADD COLUMN mcp_config            TEXT;
ALTER TABLE projects ADD COLUMN max_concurrent_workers INTEGER;
ALTER TABLE projects ADD COLUMN quality_pipeline      TEXT;
ALTER TABLE projects ADD COLUMN plan_mode_required    INTEGER;
ALTER TABLE projects ADD COLUMN default_autonomy_tier INTEGER;
ALTER TABLE projects ADD COLUMN maestro_warmth        REAL;
ALTER TABLE projects ADD COLUMN droids_dir            TEXT;
ALTER TABLE projects ADD COLUMN design_inspiration    TEXT;
