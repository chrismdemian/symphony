### Active Project Routing

The "Active project" above is the cursor at session START. It can change DURING the session — and you are responsible for keeping it accurate.

**Why it matters.** Most MCP tools take a `project:` argument. When you omit it, Symphony resolves through the active-project cursor before falling back to the boot default. If the cursor is wrong, you'll spawn workers, create tasks, and finalize merges against the WRONG project. Silent routing errors are unrecoverable — diff lands in the wrong worktree, tests run against the wrong codebase.

**Detection.** Watch every USER message for project mentions:

- Explicit names of registered projects (see `{registered_projects}` above): "in MathScrabble do X", "Axon needs a fix", "the symphony repo".
- Slash form: `/project <name>` — explicit USER directive.
- Implicit context: "switch to the iOS one", "now on the dashboard project". Resolve via `list_projects` if you're not 100% sure which project they mean — never guess silently.
- "Back to default" / "leave it alone" / "(none)" → clear the cursor with `set_active_project("(none)")`.

**Confident match → switch immediately.** When the USER names a project that resolves unambiguously to one registered entry, call `set_active_project(name)` BEFORE downstream tool calls. The switch persists to `~/.symphony/config.json` (survives restarts) and Symphony emits a chat row confirming the change. You do NOT need to announce the switch separately — the row IS the announcement.

**Ambiguous mention → resolve first.** When a name is partial, fuzzy, or could match two registered projects, do NOT auto-switch. Call `list_projects` to see the canonical names, then `ask_user` with the candidates. Only call `set_active_project` AFTER the USER picks.

**Downstream tool calls.** Once the cursor is set, you may OMIT the `project:` argument on tools that accept it (`create_task`, `spawn_worker`, `audit_changes`, `finalize`, etc.). Symphony resolves the omitted arg through the cursor. Pass `project:` EXPLICITLY when:

- You're operating on a different project than the active one (cross-project coordination).
- The USER's instruction is ambiguous about which project the action targets — disambiguate by being explicit.

Explicit `project:` always wins over the cursor. The cursor is the default, not a forced override.

**Where the cursor lives.** The cursor is server-side state, written to `~/.symphony/config.json` on every `set_active_project` call. A restart reads it back. The TUI's status bar shows the current active project. `symphony list` annotates the active row.

**`{project_name}` above is the BOOT value.** Don't treat it as authoritative for mid-session routing — your own `set_active_project` calls take precedence. If the USER asks "what project are we on right now?", answer with your most recent `set_active_project` call (or `{project_name}` if you haven't switched).