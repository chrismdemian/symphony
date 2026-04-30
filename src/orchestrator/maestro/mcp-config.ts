import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { prependTsxLoaderIfTs } from '../../utils/node-runner.js';

const MCP_CONFIG_FILENAME = '.symphony-mcp.json';

export interface WriteMaestroMcpConfigInput {
  /** Directory the file is written into (Maestro's cwd, normally). */
  cwd: string;
  /**
   * Absolute path to the bundled `dist/index.js` (or `src/index.ts` under
   * tsx). Resolved by the caller from `process.argv[1]` so the same Symphony
   * binary that booted as the parent is the one Claude spawns for MCP.
   */
  cliEntryPath: string;
  /**
   * Absolute path to the Node binary. Defaults to `process.execPath` so the
   * spawned MCP server runs under the same Node version as the parent.
   */
  nodeBinary?: string;
  /**
   * When true, pass `--in-memory` to the spawned `mcp-server` so it skips
   * SQLite. Used by tests + ephemeral debug runs. Defaults to false.
   */
  inMemory?: boolean;
  /** Override the file path entirely. Default: `<cwd>/.symphony-mcp.json`. */
  outputPath?: string;
  /** Extra MCP servers to register alongside Symphony. Off by default. */
  extraServers?: Record<string, McpServerEntry>;
}

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MaestroMcpConfigResult {
  path: string;
}

/**
 * Write the `--mcp-config` JSON file Maestro is launched with.
 *
 * The file points at `node <cliEntryPath> mcp-server`, which spawns
 * Symphony's orchestrator-server (Phase 2A/2B) as a stdio MCP child.
 * Claude reads it via `--mcp-config <path> --strict-mcp-config` (already
 * wired in `src/workers/args.ts:43-44`).
 *
 * Atomic write-then-rename so a crash mid-write doesn't leave Claude
 * pointed at a half-baked config.
 */
export async function writeMaestroMcpConfig(
  input: WriteMaestroMcpConfigInput,
): Promise<MaestroMcpConfigResult> {
  const target = input.outputPath ?? path.join(input.cwd, MCP_CONFIG_FILENAME);
  // Prepend `--import tsx` when cliEntryPath is a `.ts` file so dev mode
  // (`pnpm dev start`) works without compiling. No-op for bundled `.js`.
  const args: string[] = [...prependTsxLoaderIfTs([input.cliEntryPath, 'mcp-server'])];
  if (input.inMemory === true) args.push('--in-memory');

  const config = {
    mcpServers: {
      symphony: {
        command: input.nodeBinary ?? process.execPath,
        args,
        env: {} as Record<string, string>,
      },
      ...(input.extraServers ?? {}),
    },
  };

  const serialized = JSON.stringify(config, null, 2) + '\n';
  const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await fsp.writeFile(tmp, serialized, 'utf8');
    await fsp.rename(tmp, target);
  } catch (err) {
    fsp.unlink(tmp).catch(() => {});
    throw err;
  }
  return { path: target };
}
