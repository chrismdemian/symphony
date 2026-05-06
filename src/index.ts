#!/usr/bin/env node
import { Command } from 'commander';

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
  .description('Register a project with Symphony.')
  .action((projectPath: string) => {
    console.log(`[symphony] add ${projectPath} — not yet implemented`);
  });

program
  .command('list')
  .description('List registered projects.')
  .action(() => {
    console.log('[symphony] list — not yet implemented');
  });

program
  .command('remove <name>')
  .description('Unregister a project by name.')
  .action((name: string) => {
    console.log(`[symphony] remove ${name} — not yet implemented`);
  });

program
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

program
  .command('mcp-server')
  .description('Run the Symphony orchestrator MCP server over stdio. Spawned as a child of claude -p.')
  .option('--in-memory', 'Skip the SQLite store; use in-memory registries only (Phase 2A behavior).')
  .option('--no-rpc', 'Skip starting the WebSocket RPC server (Phase 2B.2).')
  .option('--rpc-port <n>', 'Bind port for the RPC server (0 = ephemeral).', (v) => Number.parseInt(v, 10))
  .option('--rpc-token-file <path>', 'Path for the RPC descriptor JSON (default ~/.symphony/rpc.json).')
  .action(
    async (opts: {
      inMemory?: boolean;
      rpc?: boolean;
      rpcPort?: number;
      rpcTokenFile?: string;
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
