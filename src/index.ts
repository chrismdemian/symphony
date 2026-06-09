#!/usr/bin/env node
import { Command } from 'commander';
// Type-only import — erased at compile, zero startup cost. The runtime
// `VoiceBridge` is still dynamic-imported inside the `voice listen` action
// to keep the CLI's cold-start fast.
import type { VoiceBridge } from './voice/bridge.js';

const program = new Command();

program
  .name('symphony')
  .description('Claude Code orchestrator — manage multiple claude -p workers across projects.')
  .version('0.0.0');

program
  .command('start')
  .description('Launch the Symphony orchestrator (Maestro).')
  .option('--in-memory', 'Run the bootstrap mcp-server in-memory (debug; no SQLite).')
  .option('--rpc-port <n>', 'Bootstrap mcp-server RPC port (0 = ephemeral).', (v) =>
    Number.parseInt(v, 10),
  )
  .action(async (opts: { inMemory?: boolean; rpcPort?: number }) => {
    const { runStart } = await import('./cli/start.js');
    const startOpts: Parameters<typeof runStart>[0] = {};
    if (opts.inMemory === true) startOpts.inMemory = true;
    if (opts.rpcPort !== undefined) startOpts.rpcPort = opts.rpcPort;
    const handle = await runStart(startOpts);
    await handle.done;
    process.exit(0);
  });

program
  .command('add <path>')
  .description(
    'Register a project with Symphony. Name auto-detects from --name, .symphony.json, package.json, then directory basename.',
  )
  .option('--name <name>', 'Override the auto-detected project name (slug-normalized).')
  .action(async (projectPath: string, opts: { name?: string }) => {
    const { runAdd } = await import('./cli/add.js');
    const result = await runAdd({
      projectPath,
      ...(opts.name !== undefined ? { nameOverride: opts.name } : {}),
    });
    process.exit(result.ok ? 0 : 1);
  });

program
  .command('list')
  .description('List registered projects.')
  .option('--json', 'Print as JSON instead of a table (for scripting).')
  .action(async (opts: { json?: boolean }) => {
    const { runList } = await import('./cli/list.js');
    const result = await runList({ format: opts.json === true ? 'json' : 'table' });
    process.exit(result.ok ? 0 : 1);
  });

program
  .command('remove <name>')
  .description('Unregister a project by name (or id).')
  .option('--force', 'Remove even when active workers or pending tasks exist.')
  .action(async (name: string, opts: { force?: boolean }) => {
    const { runRemove } = await import('./cli/remove.js');
    const result = await runRemove({
      nameOrId: name,
      ...(opts.force === true ? { force: true } : {}),
    });
    process.exit(result.ok ? 0 : 1);
  });

const config = program
  .command('config')
  .description(
    'Open Symphony settings (TUI). With --edit, opens ~/.symphony/config.json in $EDITOR.',
  )
  .option('--edit', 'Open the config file in $EDITOR ($VISUAL → $EDITOR → notepad/vi).')
  .option(
    '--config-file <path>',
    'Override the config file path (default ~/.symphony/config.json or $SYMPHONY_CONFIG_FILE).',
  )
  .action(async (opts: { edit?: boolean; configFile?: string }) => {
    if (opts.edit === true) {
      const { runConfigEdit } = await import('./cli/config-edit.js');
      const result = await runConfigEdit({
        ...(opts.configFile !== undefined ? { configFilePath: opts.configFile } : {}),
      });
      if (result.created) {
        console.error(`[symphony] created ${result.filePath}`);
      }
      process.exit(result.exitCode);
    }
    // No --edit: boot the TUI and pre-open the settings popup. This
    // routes through the same `runStart` as `symphony start`, so the
    // user gets the full app behind the popup — Esc closes it and they
    // continue working.
    const { runStart } = await import('./cli/start.js');
    const handle = await runStart({ initialPopup: 'settings' });
    await handle.done;
    process.exit(0);
  });

config
  .command('notion')
  .description('Configure the Notion integration (token, database, property mapping). Phase 8A.')
  .option(
    '--token <token>',
    'Notion internal-integration token (stored at ~/.symphony/integrations, mode 0600).',
  )
  .option('--database <id>', 'Notion database id or URL to sync tasks from.')
  .option('--status-prop <name>', 'Notion property mapped to task status (default "Status").')
  .option('--project-prop <name>', 'Notion property mapped to project routing (default "Project").')
  .option('--priority-prop <name>', 'Notion property mapped to priority (default "Priority").')
  .option('--status', 'Run a connection check against the configured database instead of writing config.')
  .action(
    async (opts: {
      token?: string;
      database?: string;
      statusProp?: string;
      projectProp?: string;
      priorityProp?: string;
      status?: boolean;
    }) => {
      const { runNotionConfig } = await import('./cli/notion-config.js');
      const result = await runNotionConfig({
        ...(opts.token !== undefined ? { token: opts.token } : {}),
        ...(opts.database !== undefined ? { database: opts.database } : {}),
        ...(opts.statusProp !== undefined ? { statusProp: opts.statusProp } : {}),
        ...(opts.projectProp !== undefined ? { projectProp: opts.projectProp } : {}),
        ...(opts.priorityProp !== undefined ? { priorityProp: opts.priorityProp } : {}),
        ...(opts.status === true ? { check: true } : {}),
      });
      process.exit(result.exitCode);
    },
  );

config
  .command('obsidian')
  .description('Configure the Obsidian integration (vault path, task format, routing). Phase 8B.')
  .option('--vault <path>', 'Absolute path to the Obsidian vault root (a folder of markdown).')
  .option(
    '--project-prop <name>',
    'Note frontmatter key mapped to project routing (default "project").',
  )
  .option(
    '--task-format <format>',
    'Task metadata format: emoji | dataview | auto (default "auto").',
  )
  .option('--watch', 'Enable the live vault watcher (default).')
  .option('--no-watch', 'Disable the live vault watcher (sync on demand only).')
  .option('--status', 'Run a vault check (path exists, count open tasks) instead of writing config.')
  .action(
    async (opts: {
      vault?: string;
      projectProp?: string;
      taskFormat?: string;
      watch?: boolean;
      status?: boolean;
    }) => {
      const { runObsidianConfig } = await import('./cli/obsidian-config.js');
      const result = await runObsidianConfig({
        ...(opts.vault !== undefined ? { vault: opts.vault } : {}),
        ...(opts.projectProp !== undefined ? { projectProp: opts.projectProp } : {}),
        ...(opts.taskFormat !== undefined ? { taskFormat: opts.taskFormat } : {}),
        ...(opts.watch !== undefined ? { watch: opts.watch } : {}),
        ...(opts.status === true ? { check: true } : {}),
      });
      process.exit(result.exitCode);
    },
  );

config
  .command('linear')
  .description('Configure the Linear integration (API key, team scope, writeback states). Phase 8C.')
  .option(
    '--token <key>',
    'Linear personal API key (stored in the OS keychain, or ~/.symphony/integrations fallback).',
  )
  .option('--team <key>', 'Restrict the sync to one Linear team by key (e.g. "ENG"). Omit for all teams.')
  .option(
    '--writeback-completed <state>',
    'Linear workflow state name to set on task completion (default: first completed-type state).',
  )
  .option(
    '--writeback-failed <state>',
    'Linear workflow state name to set on task failure (default: no failure writeback).',
  )
  .option('--status', 'Run a connection check against Linear instead of writing config.')
  .action(
    async (opts: {
      token?: string;
      team?: string;
      writebackCompleted?: string;
      writebackFailed?: string;
      status?: boolean;
    }) => {
      const { runLinearConfig } = await import('./cli/linear-config.js');
      const result = await runLinearConfig({
        ...(opts.token !== undefined ? { token: opts.token } : {}),
        ...(opts.team !== undefined ? { team: opts.team } : {}),
        ...(opts.writebackCompleted !== undefined
          ? { writebackCompleted: opts.writebackCompleted }
          : {}),
        ...(opts.writebackFailed !== undefined ? { writebackFailed: opts.writebackFailed } : {}),
        ...(opts.status === true ? { check: true } : {}),
      });
      process.exit(result.exitCode);
    },
  );

config
  .command('github')
  .description('Configure the GitHub Issues integration (token, repos, writeback). Phase 8C.')
  .option(
    '--token <pat>',
    'GitHub personal access token (stored in the OS keychain, or ~/.symphony/integrations fallback).',
  )
  .option(
    '--repo <owner/name>',
    'A repo to sync issues from (repeatable; accumulates across invocations).',
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option('--api-base-url <url>', 'GitHub Enterprise Server API root (default https://api.github.com).')
  .option(
    '--writeback-completed <text>',
    'Comment posted on the issue when a task completes (default "Completed by Symphony."; the issue is then closed).',
  )
  .option(
    '--writeback-failed <text>',
    'Comment posted when a task fails (default: no failure writeback; the issue is never closed on failure).',
  )
  .option('--status', 'Run a connection check against GitHub instead of writing config.')
  .action(
    async (opts: {
      token?: string;
      repo?: string[];
      apiBaseUrl?: string;
      writebackCompleted?: string;
      writebackFailed?: string;
      status?: boolean;
    }) => {
      const { runGitHubConfig } = await import('./cli/github-config.js');
      const result = await runGitHubConfig({
        ...(opts.token !== undefined ? { token: opts.token } : {}),
        ...(opts.repo !== undefined && opts.repo.length > 0 ? { repos: opts.repo } : {}),
        ...(opts.apiBaseUrl !== undefined ? { apiBaseUrl: opts.apiBaseUrl } : {}),
        ...(opts.writebackCompleted !== undefined
          ? { writebackCompleted: opts.writebackCompleted }
          : {}),
        ...(opts.writebackFailed !== undefined ? { writebackFailed: opts.writebackFailed } : {}),
        ...(opts.status === true ? { check: true } : {}),
      });
      process.exit(result.exitCode);
    },
  );

config
  .command('jira')
  .description('Configure the Jira integration (token, site URL, email, projects, writeback). Phase 8C.')
  .option(
    '--token <api-token>',
    'Jira API token (stored in the OS keychain, or ~/.symphony/integrations fallback).',
  )
  .option('--site-url <url>', 'Jira base URL, e.g. https://you.atlassian.net (https only).')
  .option('--email <email>', 'Atlassian account email (the Basic-auth username).')
  .option(
    '--project <key>',
    'A project key to lead the JQL fetch with (repeatable; accumulates across invocations).',
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option(
    '--writeback-completed <text>',
    'Comment posted on the issue when a task completes (default "Completed by Symphony."; the issue is then transitioned to Done).',
  )
  .option(
    '--writeback-transition <name>',
    'Transition name to use on completion (default: the first Done-category transition).',
  )
  .option(
    '--writeback-failed <text>',
    'Comment posted when a task fails (default: no failure writeback; the issue is never transitioned on failure).',
  )
  .option('--status', 'Run a connection check against Jira instead of writing config.')
  .action(
    async (opts: {
      token?: string;
      siteUrl?: string;
      email?: string;
      project?: string[];
      writebackCompleted?: string;
      writebackTransition?: string;
      writebackFailed?: string;
      status?: boolean;
    }) => {
      const { runJiraConfig } = await import('./cli/jira-config.js');
      const result = await runJiraConfig({
        ...(opts.token !== undefined ? { token: opts.token } : {}),
        ...(opts.siteUrl !== undefined ? { siteUrl: opts.siteUrl } : {}),
        ...(opts.email !== undefined ? { email: opts.email } : {}),
        ...(opts.project !== undefined && opts.project.length > 0 ? { projectKeys: opts.project } : {}),
        ...(opts.writebackCompleted !== undefined
          ? { writebackCompleted: opts.writebackCompleted }
          : {}),
        ...(opts.writebackTransition !== undefined
          ? { writebackTransition: opts.writebackTransition }
          : {}),
        ...(opts.writebackFailed !== undefined ? { writebackFailed: opts.writebackFailed } : {}),
        ...(opts.status === true ? { check: true } : {}),
      });
      process.exit(result.exitCode);
    },
  );

config
  .command('gitlab')
  .description('Configure the GitLab integration (token, projects, self-hosted URL, writeback). Phase 8C.')
  .option(
    '--token <pat>',
    'GitLab personal access token (stored in the OS keychain, or ~/.symphony/integrations fallback).',
  )
  .option(
    '--project <group/name>',
    'A project to sync issues from (repeatable; accumulates across invocations).',
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option('--site-url <url>', 'GitLab instance base URL (default https://gitlab.com; https only).')
  .option(
    '--writeback-completed <text>',
    'Note posted on the issue when a task completes (default "Completed by Symphony."; the issue is then closed).',
  )
  .option(
    '--writeback-failed <text>',
    'Note posted when a task fails (default: no failure writeback; the issue is never closed on failure).',
  )
  .option('--status', 'Run a connection check against GitLab instead of writing config.')
  .action(
    async (opts: {
      token?: string;
      project?: string[];
      siteUrl?: string;
      writebackCompleted?: string;
      writebackFailed?: string;
      status?: boolean;
    }) => {
      const { runGitLabConfig } = await import('./cli/gitlab-config.js');
      const result = await runGitLabConfig({
        ...(opts.token !== undefined ? { token: opts.token } : {}),
        ...(opts.project !== undefined && opts.project.length > 0 ? { projects: opts.project } : {}),
        ...(opts.siteUrl !== undefined ? { siteUrl: opts.siteUrl } : {}),
        ...(opts.writebackCompleted !== undefined
          ? { writebackCompleted: opts.writebackCompleted }
          : {}),
        ...(opts.writebackFailed !== undefined ? { writebackFailed: opts.writebackFailed } : {}),
        ...(opts.status === true ? { check: true } : {}),
      });
      process.exit(result.exitCode);
    },
  );

config
  .command('plain')
  .description('Configure the Plain integration (token, API endpoint, statuses, writeback). Phase 8C.')
  .option(
    '--token <api-key>',
    'Plain API key (stored in the OS keychain, or ~/.symphony/integrations fallback).',
  )
  .option('--api-url <url>', 'Plain Core API GraphQL endpoint (default UK region; https only).')
  .option(
    '--statuses <list>',
    'Comma-separated thread statuses to import (TODO,SNOOZED,DONE; default TODO).',
    (value: string) => value.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
  )
  .option(
    '--writeback-completed <text>',
    'Internal note posted on the thread when a task completes (default "Completed by Symphony."; the thread is then marked Done).',
  )
  .option(
    '--writeback-failed <text>',
    'Internal note posted when a task fails (default: no failure writeback; the thread is never marked Done on failure).',
  )
  .option('--status', 'Run a connection check against Plain instead of writing config.')
  .action(
    async (opts: {
      token?: string;
      apiUrl?: string;
      statuses?: string[];
      writebackCompleted?: string;
      writebackFailed?: string;
      status?: boolean;
    }) => {
      const { runPlainConfig } = await import('./cli/plain-config.js');
      const result = await runPlainConfig({
        ...(opts.token !== undefined ? { token: opts.token } : {}),
        ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
        ...(opts.statuses !== undefined && opts.statuses.length > 0 ? { statuses: opts.statuses } : {}),
        ...(opts.writebackCompleted !== undefined
          ? { writebackCompleted: opts.writebackCompleted }
          : {}),
        ...(opts.writebackFailed !== undefined ? { writebackFailed: opts.writebackFailed } : {}),
        ...(opts.status === true ? { check: true } : {}),
      });
      process.exit(result.exitCode);
    },
  );

config
  .command('forgejo')
  .description('Configure the Forgejo integration (token, instance URL, repos, writeback). Phase 8C.')
  .option(
    '--token <pat>',
    'Forgejo personal access token (stored in the OS keychain, or ~/.symphony/integrations fallback).',
  )
  .option('--site-url <url>', 'Forgejo instance base URL, e.g. https://code.example.com (https only; required).')
  .option(
    '--repo <owner/name>',
    'A repo to sync issues from (repeatable; accumulates across invocations).',
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option(
    '--writeback-completed <text>',
    'Comment posted on the issue when a task completes (default "Completed by Symphony."; the issue is then closed).',
  )
  .option(
    '--writeback-failed <text>',
    'Comment posted when a task fails (default: no failure writeback; the issue is never closed on failure).',
  )
  .option('--status', 'Run a connection check against Forgejo instead of writing config.')
  .action(
    async (opts: {
      token?: string;
      siteUrl?: string;
      repo?: string[];
      writebackCompleted?: string;
      writebackFailed?: string;
      status?: boolean;
    }) => {
      const { runForgejoConfig } = await import('./cli/forgejo-config.js');
      const result = await runForgejoConfig({
        ...(opts.token !== undefined ? { token: opts.token } : {}),
        ...(opts.siteUrl !== undefined ? { siteUrl: opts.siteUrl } : {}),
        ...(opts.repo !== undefined && opts.repo.length > 0 ? { repos: opts.repo } : {}),
        ...(opts.writebackCompleted !== undefined
          ? { writebackCompleted: opts.writebackCompleted }
          : {}),
        ...(opts.writebackFailed !== undefined ? { writebackFailed: opts.writebackFailed } : {}),
        ...(opts.status === true ? { check: true } : {}),
      });
      process.exit(result.exitCode);
    },
  );

config
  .command('sentry')
  .description('Configure the Sentry integration (auth token, org, projects, writeback). Phase 8D.')
  .option(
    '--token <auth-token>',
    'Sentry auth token — scope event:read, + event:write for --writeback-resolve (stored in the OS keychain, or ~/.symphony/integrations fallback). NOT a DSN.',
  )
  .option('--org <slug>', 'Sentry organization slug (required to enable syncing).')
  .option(
    '--project <slug>',
    'A Sentry project to pull unresolved issues from (repeatable; accumulates across invocations).',
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  )
  .option('--url <url>', 'Sentry instance base URL (default https://sentry.io; https only). Use a region or self-hosted host.')
  .option(
    '--writeback-completed <text>',
    'Internal note posted on the Sentry issue when a task completes (default "Investigated by Symphony."). A note never changes status.',
  )
  .option(
    '--writeback-failed <text>',
    'Internal note posted when a task fails (default: no failure writeback).',
  )
  .option(
    '--writeback-resolve',
    'Also mark the Sentry issue resolved on task completion (default off — investigating an error is not the same as fixing it).',
  )
  .option('--status', 'Run a connection check against Sentry instead of writing config.')
  .action(
    async (opts: {
      token?: string;
      org?: string;
      project?: string[];
      url?: string;
      writebackCompleted?: string;
      writebackFailed?: string;
      writebackResolve?: boolean;
      status?: boolean;
    }) => {
      const { runSentryConfig } = await import('./cli/sentry-config.js');
      const result = await runSentryConfig({
        ...(opts.token !== undefined ? { token: opts.token } : {}),
        ...(opts.org !== undefined ? { org: opts.org } : {}),
        ...(opts.project !== undefined && opts.project.length > 0 ? { projects: opts.project } : {}),
        ...(opts.url !== undefined ? { baseUrl: opts.url } : {}),
        ...(opts.writebackCompleted !== undefined
          ? { writebackCompleted: opts.writebackCompleted }
          : {}),
        ...(opts.writebackFailed !== undefined ? { writebackFailed: opts.writebackFailed } : {}),
        ...(opts.writebackResolve === true ? { writebackResolve: true } : {}),
        ...(opts.status === true ? { check: true } : {}),
      });
      process.exit(result.exitCode);
    },
  );

program
  .command('reset')
  .description(
    'Wipe all Symphony workers, tasks, questions, and worktrees. User config preserved.',
  )
  .option('--force', 'Skip the typed-confirmation prompt (CI / scripted).')
  .action(async (opts: { force?: boolean }) => {
    const { runReset } = await import('./cli/reset.js');
    const result = await runReset({ force: opts.force === true });
    process.exit(result.ok ? 0 : 1);
  });

const skills = program
  .command('skills')
  .description('Manage persistent, cross-project skills (~/.symphony/skills).');

skills
  .command('install <source>')
  .description(
    'Install a skill from a directory containing SKILL.md, or a .md file.',
  )
  .option('--id <id>', 'Override the skill id (default: source basename).')
  .action(async (source: string, opts: { id?: string }) => {
    const { runSkillsInstall } = await import('./cli/skills.js');
    const result = await runSkillsInstall({
      source,
      ...(opts.id !== undefined ? { id: opts.id } : {}),
    });
    process.exit(result.exitCode);
  });

skills
  .command('list')
  .description('List installed skills and their agent-link status.')
  .action(async () => {
    const { runSkillsList } = await import('./cli/skills.js');
    const result = await runSkillsList();
    process.exit(result.exitCode);
  });

skills
  .command('sync-bundled')
  .description('Install/refresh the bundled skill set (idempotent).')
  .option('--force', 'Reinstall even if already up-to-date.')
  .action(async (opts: { force?: boolean }) => {
    const { runSkillsSyncBundled } = await import('./cli/skills.js');
    const result = await runSkillsSyncBundled(
      opts.force === true ? { force: true } : {},
    );
    process.exit(result.exitCode);
  });

skills
  .command('uninstall <name>')
  .description('Remove a skill and its agent symlink.')
  .action(async (name: string) => {
    const { runSkillsUninstall } = await import('./cli/skills.js');
    const result = await runSkillsUninstall({ id: name });
    process.exit(result.exitCode);
  });

const plugin = program
  .command('plugin')
  .description('Manage Symphony plugins (~/.symphony/plugins). Phase 7A.');

plugin
  .command('new <name>')
  .description('Scaffold a new plugin project (uses @symphony/plugin-sdk). Phase 7B.')
  .option('--out <dir>', 'Target directory (default: ./<id>).')
  .option('--author <author>', 'Plugin author for the manifest.')
  .option('--force', 'Scaffold into a non-empty directory.')
  .action(async (name: string, opts: { out?: string; author?: string; force?: boolean }) => {
    const { runPluginNew } = await import('./cli/plugin-new.js');
    const result = await runPluginNew({
      name,
      ...(opts.out !== undefined ? { out: opts.out } : {}),
      ...(opts.author !== undefined ? { author: opts.author } : {}),
      ...(opts.force === true ? { force: true } : {}),
    });
    process.exit(result.exitCode);
  });

plugin
  .command('install <source>')
  .description(
    'Install a plugin from a local directory / plugin.json path, an npm package spec (pkg, @scope/pkg, pkg@1.2.3), or a git URL (optional #ref). Remote fetches run with --ignore-scripts.',
  )
  .option(
    '--allow-scripts',
    'Run the plugin’s install/build scripts during a remote fetch (executes author code; off by default).',
  )
  .action(async (source: string, opts: { allowScripts?: boolean }) => {
    const { runPluginInstall } = await import('./cli/plugin.js');
    const result = await runPluginInstall({
      source,
      ...(opts.allowScripts === true ? { allowScripts: true } : {}),
    });
    process.exit(result.exitCode);
  });

plugin
  .command('list')
  .description('List installed plugins and their enabled state.')
  .option('--json', 'Print as JSON instead of a table (for scripting).')
  .action(async (opts: { json?: boolean }) => {
    const { runPluginList } = await import('./cli/plugin.js');
    const result = await runPluginList({ format: opts.json === true ? 'json' : 'table' });
    process.exit(result.exitCode);
  });

plugin
  .command('remove <id>')
  .description('Uninstall a plugin by id (removes the dir and the registry row).')
  .action(async (id: string) => {
    const { runPluginRemove } = await import('./cli/plugin.js');
    const result = await runPluginRemove({ id });
    process.exit(result.exitCode);
  });

plugin
  .command('enable <id>')
  .description('Enable an installed plugin (loads at next Symphony start).')
  .action(async (id: string) => {
    const { runPluginEnable } = await import('./cli/plugin.js');
    const result = await runPluginEnable({ id });
    process.exit(result.exitCode);
  });

plugin
  .command('disable <id>')
  .description('Disable an installed plugin (stops loading at next Symphony start).')
  .action(async (id: string) => {
    const { runPluginDisable } = await import('./cli/plugin.js');
    const result = await runPluginDisable({ id });
    process.exit(result.exitCode);
  });

program
  .command('update-catalogs')
  .description(
    'Vendor the awesome-design-md design catalog into ~/.symphony/design-catalog/ for the bundled design-researcher droid (Phase 4F.2).',
  )
  .option('--force', 'Refetch every slug (default: skip slugs already present).')
  .option('--slug <name>', 'Only update one slug (matches `getdesign list`).')
  .option('--vendor-dir <path>', 'Override the vendor directory.')
  .action(
    async (opts: { force?: boolean; slug?: string; vendorDir?: string }) => {
      const { runUpdateCatalogs } = await import('./cli/update-catalogs.js');
      const result = await runUpdateCatalogs({
        ...(opts.force === true ? { force: true } : {}),
        ...(opts.slug !== undefined ? { only: opts.slug } : {}),
        ...(opts.vendorDir !== undefined ? { vendorDir: opts.vendorDir } : {}),
      });
      process.exit(result.exitCode);
    },
  );

const voice = program
  .command('voice')
  .description(
    'Voice subsystem (Phase 6A) — install the local Python bridge or run a VAD diagnose.',
  );

voice
  .command('install')
  .description(
    'Bootstrap the Python venv at ~/.symphony/voice-env (silero-vad + sounddevice + numpy; pyaudio best-effort).',
  )
  .option('--force', 'Reinstall even when deps are already present.')
  .action(async (opts: { force?: boolean }) => {
    const { runVoiceInstall } = await import('./cli/voice-install.js');
    const result = await runVoiceInstall(opts.force === true ? { force: true } : {});
    process.exit(result.exitCode);
  });

voice
  .command('diagnose')
  .description(
    'Pipe a known PCM fixture through the bridge and assert VAD events fire. Exits 0 on PASS.',
  )
  .option('--json', 'Emit a single-line JSON summary instead of human output.')
  .option(
    '--wake-word',
    'Phase 6C — run in wake-word mode: pipe wake-symphony-3s.pcm + assert ≥1 wake_word event.',
  )
  .option(
    '--wake-word-threshold <n>',
    'Override the wake-word activation threshold (0..1, default 0.5).',
    (v) => Number.parseFloat(v),
  )
  .action(
    async (opts: {
      json?: boolean;
      wakeWord?: boolean;
      wakeWordThreshold?: number;
    }) => {
      const { runVoiceDiagnose } = await import('./cli/voice-diagnose.js');
      const wakeWordThreshold =
        opts.wakeWordThreshold !== undefined &&
        Number.isFinite(opts.wakeWordThreshold)
          ? opts.wakeWordThreshold
          : undefined;
      const result = await runVoiceDiagnose({
        ...(opts.json === true ? { format: 'json' as const } : {}),
        ...(opts.wakeWord === true ? { wakeWord: true } : {}),
        ...(wakeWordThreshold !== undefined ? { wakeWordThreshold } : {}),
      });
      process.exit(result.exitCode);
    },
  );

voice
  .command('listen')
  .description(
    'Phase 6C — listen on the live mic for wake-word events. Press Ctrl-C to exit.',
  )
  .option('--json', 'Emit one JSON event per line instead of human output.')
  .option(
    '--threshold <n>',
    'Override the wake-word activation threshold (0..1, default from voice.wakeWordThreshold config).',
    (v) => Number.parseFloat(v),
  )
  .option(
    '--cooldown-ms <n>',
    'Override the post-fire cooldown in ms (default from voice.wakeWordCooldownMs config).',
    (v) => Number.parseInt(v, 10),
  )
  .option(
    '--sustain-frames <n>',
    'Override the sustain-frame count (default from voice.wakeWordSustainFrames config).',
    (v) => Number.parseInt(v, 10),
  )
  .option(
    '--max-events <n>',
    'Auto-exit after N wake-word events (default 0 = unbounded).',
    (v) => Number.parseInt(v, 10),
  )
  .option(
    '--model <name>',
    'Override the wake-word model name (default from voice.wakeWordModel config).',
  )
  .action(
    async (opts: {
      json?: boolean;
      threshold?: number;
      cooldownMs?: number;
      sustainFrames?: number;
      maxEvents?: number;
      model?: string;
    }) => {
      const { runVoiceListen } = await import('./cli/voice-listen.js');
      const threshold =
        opts.threshold !== undefined && Number.isFinite(opts.threshold)
          ? opts.threshold
          : undefined;
      const cooldownMs =
        opts.cooldownMs !== undefined && !Number.isNaN(opts.cooldownMs)
          ? opts.cooldownMs
          : undefined;
      const sustainFrames =
        opts.sustainFrames !== undefined && !Number.isNaN(opts.sustainFrames)
          ? opts.sustainFrames
          : undefined;
      const maxEvents =
        opts.maxEvents !== undefined && !Number.isNaN(opts.maxEvents)
          ? opts.maxEvents
          : undefined;
      // SIGINT (Ctrl-C) handling (audit-M3, mirrors the 3T two-tap pattern).
      // First Ctrl-C: abort the signal → runVoiceListen calls bridge.stop()
      // for a graceful mic release. Second Ctrl-C (impatient user during
      // the 2 s grace): force-kill the bridge's Python subprocess
      // synchronously, then exit 130. Without the second-tap force path,
      // a double Ctrl-C on Win32 (where SIGINT isn't delivered to the
      // child) orphans python.exe with the mic still open — a CLAUDE.md
      // cleanup violation.
      const abortController = new AbortController();
      let sigintCount = 0;
      let listenBridge: VoiceBridge | undefined;
      const onSigint = (): void => {
        sigintCount += 1;
        if (sigintCount === 1) {
          abortController.abort();
        } else {
          // Second press — don't wait for graceful stop. Force-kill the
          // child tree (Win32 taskkill / POSIX SIGKILL via forceStop) then
          // bail with the conventional 128+SIGINT(2) = 130 code.
          if (listenBridge !== undefined) {
            void listenBridge.stop({ graceMs: 0 }).catch(() => undefined);
          }
          process.exit(130);
        }
      };
      process.on('SIGINT', onSigint);
      try {
        const { VoiceBridge } = await import('./voice/bridge.js');
        listenBridge = new VoiceBridge();
        const result = await runVoiceListen({
          ...(opts.json === true ? { format: 'json' as const } : {}),
          ...(threshold !== undefined ? { threshold } : {}),
          ...(cooldownMs !== undefined ? { cooldownMs } : {}),
          ...(sustainFrames !== undefined ? { sustainFrames } : {}),
          ...(maxEvents !== undefined ? { maxEvents } : {}),
          ...(opts.model !== undefined ? { modelName: opts.model } : {}),
          bridgeFactory: () => listenBridge!,
          signal: abortController.signal,
        });
        process.exit(result.exitCode);
      } finally {
        process.off('SIGINT', onSigint);
      }
    },
  );

voice
  .command('transcribe <file>')
  .description(
    'Transcribe a 16kHz mono WAV or raw PCM file via Moonshine. Prints the joined transcript.',
  )
  .option('--json', 'Emit a single-line JSON summary instead of human output.')
  .option('--stt-model <name>', 'Override the Moonshine model (moonshine/base | moonshine/tiny).')
  .option('--partial-interval-ms <n>', 'Override the partial-transcription cadence (default: 200).', (v) =>
    Number.parseInt(v, 10),
  )
  .option(
    '--max-utterance-seconds <n>',
    'Override the hard-cap utterance length (default: 30).',
    (v) => Number.parseInt(v, 10),
  )
  .action(
    async (
      file: string,
      opts: {
        json?: boolean;
        sttModel?: string;
        partialIntervalMs?: number;
        maxUtteranceSeconds?: number;
      },
    ) => {
      const { runVoiceTranscribe } = await import('./cli/voice-transcribe.js');
      const sttModel =
        opts.sttModel === 'moonshine/base' || opts.sttModel === 'moonshine/tiny'
          ? opts.sttModel
          : undefined;
      const partialIntervalMs =
        opts.partialIntervalMs !== undefined && !Number.isNaN(opts.partialIntervalMs)
          ? opts.partialIntervalMs
          : undefined;
      const maxUtteranceSeconds =
        opts.maxUtteranceSeconds !== undefined && !Number.isNaN(opts.maxUtteranceSeconds)
          ? opts.maxUtteranceSeconds
          : undefined;
      const result = await runVoiceTranscribe({
        wavPath: file,
        ...(opts.json === true ? { format: 'json' as const } : {}),
        ...(sttModel !== undefined ? { sttModel } : {}),
        ...(partialIntervalMs !== undefined ? { partialIntervalMs } : {}),
        ...(maxUtteranceSeconds !== undefined ? { maxUtteranceSeconds } : {}),
      });
      process.exit(result.exitCode);
    },
  );

voice
  .command('capture')
  .description(
    'Phase 6D — always-capture: store VAD-gated transcripts in the rolling context buffer. Press Ctrl-C to stop.',
  )
  .option('--json', 'Emit one JSON line per stored chunk instead of human output.')
  .option(
    '--max-events <n>',
    'Auto-exit after N stored transcript chunks (default 0 = unbounded).',
    (v) => Number.parseInt(v, 10),
  )
  .option(
    '--max-seconds <n>',
    'Auto-exit after N seconds (default 0 = unbounded).',
    (v) => Number.parseInt(v, 10),
  )
  .option(
    '--pcm <file>',
    'Fixture mode: pipe a 16kHz mono PCM file instead of opening the mic (no microphone required).',
  )
  .action(
    async (opts: { json?: boolean; maxEvents?: number; maxSeconds?: number; pcm?: string }) => {
      const { runVoiceCapture } = await import('./cli/voice-capture.js');
      const maxEvents =
        opts.maxEvents !== undefined && !Number.isNaN(opts.maxEvents) ? opts.maxEvents : undefined;
      const maxSeconds =
        opts.maxSeconds !== undefined && !Number.isNaN(opts.maxSeconds) ? opts.maxSeconds : undefined;
      // SIGINT two-tap (mirrors `voice listen`, 6C audit-M3): first Ctrl-C
      // aborts gracefully (final compaction + clean teardown); second
      // force-kills the bridge's Python subprocess and exits 130 so a
      // double-press on Win32 can't orphan python.exe with the mic open.
      const abortController = new AbortController();
      let sigintCount = 0;
      let captureBridge: VoiceBridge | undefined;
      const onSigint = (): void => {
        sigintCount += 1;
        if (sigintCount === 1) {
          abortController.abort();
        } else {
          if (captureBridge !== undefined) {
            void captureBridge.stop({ graceMs: 0 }).catch(() => undefined);
          }
          process.exit(130);
        }
      };
      process.on('SIGINT', onSigint);
      try {
        const { VoiceBridge } = await import('./voice/bridge.js');
        captureBridge = new VoiceBridge();
        const result = await runVoiceCapture({
          ...(opts.json === true ? { format: 'json' as const } : {}),
          ...(maxEvents !== undefined ? { maxEvents } : {}),
          ...(maxSeconds !== undefined ? { maxSeconds } : {}),
          ...(opts.pcm !== undefined
            ? { inputMode: 'stdin-pcm' as const, fixturePath: opts.pcm }
            : {}),
          bridgeFactory: () => captureBridge!,
          signal: abortController.signal,
        });
        process.exit(result.exitCode);
      } finally {
        process.off('SIGINT', onSigint);
      }
    },
  );

const automations = program
  .command('automations')
  .description('Manage scheduled automations that fire a prompt into Maestro. Phase 8D.');

automations
  .command('list')
  .description('List defined automations + their schedules and next-run times.')
  .option('--json', 'Print as JSON to stdout.')
  .action(async (opts: { json?: boolean }) => {
    const { runAutomationsList } = await import('./cli/automations.js');
    const result = runAutomationsList(opts.json === true ? { json: true } : {});
    process.exit(result.exitCode);
  });

automations
  .command('add <name>')
  .description('Add a schedule (--every daily --at 09:00) or trigger (--trigger github_issue) automation.')
  .requiredOption('--prompt <text>', 'The prompt fired into Maestro when the automation runs.')
  .option('--every <interval>', 'SCHEDULE interval: hourly | daily | weekly | monthly. Mutually exclusive with --trigger.')
  .option(
    '--trigger <type>',
    'TRIGGER event source: github_issue | linear_issue | jira_issue | gitlab_issue | plain_thread | forgejo_issue | sentry_error. Mutually exclusive with --every.',
  )
  .option('--at <hh:mm>', 'Time of day (24h), e.g. 09:30. Hourly uses only the minute.')
  .option('--on <day>', 'Day of week for --every weekly: sun|mon|tue|wed|thu|fri|sat.')
  .option('--day <n>', 'Day of month (1-31) for --every monthly.')
  .option('--project <name>', 'Target project (context for Maestro). Optional.')
  .option('--disabled', 'Create the automation disabled (does not fire until enabled).')
  .option(
    '--label <name>',
    'TRIGGER filter: only fire for events carrying this label (repeatable; OR; case-insensitive).',
    (value: string, prev: string[]) => prev.concat(value),
    [] as string[],
  )
  .option('--assignee <name>', 'TRIGGER filter: only fire for events assigned to this user (case-insensitive).')
  .option('--branch <glob>', 'TRIGGER filter: only fire for events on a matching branch (glob, e.g. "feature/*"). PR sources only.')
  .action(
    async (
      name: string,
      opts: {
        prompt: string;
        every?: string;
        trigger?: string;
        at?: string;
        on?: string;
        day?: string;
        project?: string;
        disabled?: boolean;
        label?: string[];
        assignee?: string;
        branch?: string;
      },
    ) => {
      const { runAutomationsAdd } = await import('./cli/automations.js');
      const result = runAutomationsAdd({
        name,
        prompt: opts.prompt,
        ...(opts.every !== undefined ? { every: opts.every } : {}),
        ...(opts.trigger !== undefined ? { trigger: opts.trigger } : {}),
        ...(opts.at !== undefined ? { at: opts.at } : {}),
        ...(opts.on !== undefined ? { on: opts.on } : {}),
        ...(opts.day !== undefined ? { day: opts.day } : {}),
        ...(opts.project !== undefined ? { project: opts.project } : {}),
        ...(opts.disabled === true ? { disabled: true } : {}),
        ...(opts.label !== undefined && opts.label.length > 0 ? { labels: opts.label } : {}),
        ...(opts.assignee !== undefined ? { assignee: opts.assignee } : {}),
        ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
      });
      process.exit(result.exitCode);
    },
  );

automations
  .command('remove <id>')
  .description('Delete an automation (and its run logs).')
  .action(async (id: string) => {
    const { runAutomationsRemove } = await import('./cli/automations.js');
    const result = runAutomationsRemove({ id });
    process.exit(result.exitCode);
  });

automations
  .command('disable <id>')
  .description('Disable an automation without deleting it.')
  .action(async (id: string) => {
    const { runAutomationsSetEnabled } = await import('./cli/automations.js');
    const result = runAutomationsSetEnabled({ id, enabled: false });
    process.exit(result.exitCode);
  });

automations
  .command('enable <id>')
  .description('Re-enable a disabled automation.')
  .action(async (id: string) => {
    const { runAutomationsSetEnabled } = await import('./cli/automations.js');
    const result = runAutomationsSetEnabled({ id, enabled: true });
    process.exit(result.exitCode);
  });

automations
  .command('run <id>')
  .description('Force an automation due now — it fires on a running session\'s next tick.')
  .action(async (id: string) => {
    const { runAutomationsRun } = await import('./cli/automations.js');
    const result = runAutomationsRun({ id });
    process.exit(result.exitCode);
  });

program
  .command('mcp-server')
  .description('Run the Symphony orchestrator MCP server over stdio. Spawned as a child of claude -p.')
  .option('--in-memory', 'Skip the SQLite store; use in-memory registries only (Phase 2A behavior).')
  .option('--no-rpc', 'Skip starting the WebSocket RPC server (Phase 2B.2).')
  .option('--rpc-port <n>', 'Bind port for the RPC server (0 = ephemeral).', (v) => Number.parseInt(v, 10))
  .option('--rpc-token-file <path>', 'Path for the RPC descriptor JSON (default ~/.symphony/rpc.json).')
  .option('--default-project <path>', 'Absolute path to the default project (overrides cwd).')
  .option('--plugins', 'Activate the plugin host (Phase 7A). Only Maestro’s MCP child passes this.')
  .action(
    async (opts: {
      inMemory?: boolean;
      rpc?: boolean;
      rpcPort?: number;
      rpcTokenFile?: string;
      defaultProject?: string;
      plugins?: boolean;
    }) => {
      const { startOrchestratorServer, SymphonyDatabase } = await import('./orchestrator/index.js');
      const database = opts.inMemory ? undefined : SymphonyDatabase.open();
      let handle;
      try {
        const rpcEnabled = opts.rpc !== false;
        const rpcPort = opts.rpcPort;
        const rpcTokenFilePath = opts.rpcTokenFile;
        handle = await startOrchestratorServer({
          ...(database !== undefined ? { database } : {}),
          ...(opts.defaultProject !== undefined ? { defaultProjectPath: opts.defaultProject } : {}),
          ...(opts.plugins === true ? { plugins: { enabled: true } } : {}),
          // Phase 8A — activate the Notion connector whenever a DB is open
          // (both the bootstrap RPC server AND Maestro's MCP child). The
          // connector reads ~/.symphony/integrations/notion.json + token and
          // is undefined (zero overhead) when Notion isn't configured; no
          // network call happens until sync_notion / a writeback fires.
          // Construction in both processes gives complete writeback coverage
          // (Maestro-driven AND TUI/RPC-driven task transitions) with no
          // double-fire — a given update() runs in exactly one process.
          ...(database !== undefined ? { notion: { enabled: true } } : {}),
          // Phase 8B — activate the Obsidian connector whenever a DB is open.
          // Reads ~/.symphony/integrations/obsidian.json (no token — a vault is
          // a local folder); undefined (zero overhead) when unconfigured. The
          // sync_obsidian tool + checkbox writeback + the live watcher wire up
          // only when a vault is configured. The watcher runs in this process;
          // double-construction across both servers is fine — a given task
          // update() fires its writeback in exactly one process (single-writer).
          ...(database !== undefined ? { obsidian: { enabled: true } } : {}),
          // Phase 8C — activate the Linear connector whenever a DB is open.
          // Reads the stored Linear API key (OS keychain / file fallback);
          // undefined (zero overhead) when no key is stored. The sync_linear
          // tool + issue writeback wire up only when configured. Same
          // double-construction-is-safe property as Notion/Obsidian.
          ...(database !== undefined ? { linear: { enabled: true } } : {}),
          // Phase 8C.2 — activate the GitHub connector whenever a DB is open.
          // Reads the stored token + github.json repos; undefined (zero
          // overhead) when no token / no repos. The sync_github tool + the
          // comment+close writeback wire up only when configured. Same
          // double-construction-is-safe property as Notion/Obsidian/Linear.
          ...(database !== undefined ? { github: { enabled: true } } : {}),
          // Phase 8C.3 — activate the Jira connector whenever a DB is open.
          // Reads the stored token + jira.json site URL/email; undefined (zero
          // overhead) when not fully configured. The sync_jira tool + the
          // comment+transition writeback wire up only when configured.
          ...(database !== undefined ? { jira: { enabled: true } } : {}),
          // Phase 8C.3 — activate the GitLab connector whenever a DB is open.
          // Reads the stored token + gitlab.json projects; undefined (zero
          // overhead) when no token / no projects. The sync_gitlab tool + the
          // note+close writeback wire up only when configured.
          ...(database !== undefined ? { gitlab: { enabled: true } } : {}),
          // Phase 8C.4 — activate the Plain connector whenever a DB is open.
          // Token-only activation (like Linear); undefined (zero overhead) when
          // no token. The sync_plain tool + the note+done writeback wire up only
          // when configured.
          ...(database !== undefined ? { plain: { enabled: true } } : {}),
          // Phase 8C.4 — activate the Forgejo connector whenever a DB is open.
          // Reads the stored token + forgejo.json site URL/repos; undefined
          // (zero overhead) when not fully configured. The sync_forgejo tool +
          // the comment+close writeback wire up only when configured.
          ...(database !== undefined ? { forgejo: { enabled: true } } : {}),
          // Phase 8D.5 — activate the Sentry connector whenever a DB is open.
          // Reads the stored token + sentry.json org/projects; undefined (zero
          // overhead) when not fully configured. The sync_sentry tool, the
          // sentry_error trigger source, and the note (opt-in resolve) writeback
          // wire up only when configured.
          ...(database !== undefined ? { sentry: { enabled: true } } : {}),
          // Phase 8D.1 — activate the automation scheduler whenever a DB is
          // open. server.ts enforces EXACTLY-ONE-SCHEDULER (runs only in the
          // non-`--plugins` Process B) AND the `automationsEnabled` config
          // master switch. Zero overhead when no automations are defined.
          ...(database !== undefined ? { automations: { enabled: true } } : {}),
          rpc: rpcEnabled
            ? {
                enabled: true,
                ...(rpcPort !== undefined ? { port: rpcPort } : {}),
                ...(rpcTokenFilePath !== undefined ? { tokenFilePath: rpcTokenFilePath } : {}),
              }
            : { enabled: false },
        });
      } catch (err) {
        // Phase 2B.1 audit M6 — close the DB on server-start failure
        // so the WAL/SHM sidecars flush cleanly before the process exits.
        database?.close();
        throw err;
      }
      if (handle.rpc !== undefined) {
        // Single parseable line on stderr for clients that want to reach
        // the orchestrator without scraping `~/.symphony/rpc.json`.
        const rpc = handle.rpc;
        const advert = {
          event: 'symphony.rpc.ready',
          host: rpc.host,
          port: rpc.port,
          tokenFile: rpc.tokenFilePath ?? null,
        };
        console.error(`[symphony] ${JSON.stringify(advert)}`);
      }
      // Audit M5 (2B.2 review): hard deadline so a wedged WS client
      // can't block process exit indefinitely. SIGTERM should always
      // exit; if `handle.close()` doesn't drain in 5s, force-exit.
      const SHUTDOWN_DEADLINE_MS = 5_000;
      const shutdown = async (_signal: string) => {
        let exitCode = 0;
        const timer = setTimeout(() => {
          console.error(
            `[symphony] graceful close exceeded ${SHUTDOWN_DEADLINE_MS}ms — forcing exit`,
          );
          process.exit(1);
        }, SHUTDOWN_DEADLINE_MS);
        timer.unref?.();
        try {
          await handle
            .close()
            .catch((e) => console.error('[symphony] server close failed:', e));
        } finally {
          try {
            database?.close();
          } catch (e) {
            console.error('[symphony] database close failed:', e);
            exitCode = 1;
          }
          clearTimeout(timer);
          process.exit(exitCode);
        }
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      process.stdin.on('close', () => void shutdown('stdin-close'));
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
