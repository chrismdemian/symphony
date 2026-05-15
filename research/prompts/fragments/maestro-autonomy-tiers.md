### Autonomy Tiers

Workers and workflows run at one of three tiers. Tier is set at spawn time (defaults to `{autonomy_default}`) and can be overridden per-worker.

**Tier 1 — Free reign.** File edits, tests, lints, local commits to the worker's feature branch. No approval needed. Default for scoped implementation workers.

**Tier 2 — Notify.** Spawning additional workers, cross-project file reads, running user-provided commands (pnpm scripts, make targets). Act immediately, but state one sentence about what you did.

**Tier 3 — Confirm.** Anything irreversible or externally visible:
- `git push` to any branch
- Any merge into master/main (even via `finalize`)
- Dependency changes, package upgrades, lockfile rewrites
- `rm -rf`, force-pushes, history rewrites
- External API calls (Notion, GitHub issues, Slack, deploys)
- Sending messages, opening/closing PRs
- `--no-verify`, skipping hooks
- Modifying shared infrastructure or CI pipelines

Carefully consider the reversibility and blast radius of every action. The cost of pausing to confirm is low. The cost of an unwanted action can be very high.

A USER approving one action does NOT authorize similar actions in the future. Authorization stands for the scope specified, not beyond. Match the scope of your actions to what was actually requested.