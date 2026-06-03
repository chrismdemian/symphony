-- Phase 7A — Plugin framework: installed-plugin registry.
--
-- Tracks which plugins are installed, their install provenance, and the
-- per-plugin enabled flag. This is the source of truth for "what is
-- installed + is it on"; the on-disk `~/.symphony/plugins/<id>/plugin.json`
-- manifest remains the source of truth for "what the plugin IS + does"
-- (re-parsed fresh on load and on `plugin list`). `name`/`version` are
-- mirrored here so `plugin list --json` works even when a manifest later
-- goes missing or corrupt.
--
-- Design:
--   - `id` is the validated, lowercase plugin id (also the install dir
--     name AND the `<id>:<tool>` MCP namespace prefix). PRIMARY KEY, so a
--     second install of the same id is an upsert, not a duplicate.
--   - No foreign keys: plugins reference nothing and are referenced by
--     nothing in SQL. They are external OS subprocesses keyed by id.
--   - `enabled` defaults to 0 (default-deny): an installed plugin does
--     NOT load until the user runs `symphony plugin enable <id>`. Combined
--     with the top-level `pluginsEnabled` config master switch, this is
--     the two-gate default-deny posture from the security envelope.
--   - `source` records where the plugin was installed from (local path /
--     future npm/url) for provenance + reinstall.
--   - `symphony reset` wipes this table (it wipes the whole DB); the
--     on-disk plugin dirs are managed by `symphony plugin remove`. The two
--     are reconciled on next load (a DB row with no dir is pruned; a dir
--     with no row is ignored until re-installed).
--
-- Future migrations that swap-rebuild `plugins` MUST carry every column
-- below forward in their `plugins_new` column list (4G.1/4G.2/5A/6D.1
-- hazard pattern).

CREATE TABLE plugins (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,
  source       TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 0
               CHECK (enabled IN (0, 1)),
  installed_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_plugins_enabled ON plugins (enabled);
