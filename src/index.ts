#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program
  .name('symphony')
  .description('Claude Code orchestrator — manage multiple claude -p workers across projects.')
  .version('0.0.0');

program
  .command('start')
  .description('Launch the Symphony TUI and orchestrator.')
  .action(() => {
    console.log('[symphony] start — not yet implemented');
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
  .command('mcp-server')
  .description('Run the Symphony orchestrator MCP server over stdio. Spawned as a child of claude -p.')
  .action(async () => {
    const { startOrchestratorServer } = await import('./orchestrator/index.js');
    const handle = await startOrchestratorServer();
    const shutdown = async (_signal: string) => {
      try {
        await handle.close();
      } finally {
        process.exit(0);
      }
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.stdin.on('close', () => void shutdown('stdin-close'));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
