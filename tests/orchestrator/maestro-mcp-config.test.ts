import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeMaestroMcpConfig } from '../../src/orchestrator/maestro/mcp-config.js';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-mcp-config-'));
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('writeMaestroMcpConfig', () => {
  it('writes the symphony MCP server entry pointing at node + cli mcp-server', async () => {
    const result = await writeMaestroMcpConfig({
      cwd: sandbox,
      cliEntryPath: '/abs/path/to/dist/index.js',
      nodeBinary: '/abs/node',
    });
    expect(result.path).toBe(join(sandbox, '.symphony-mcp.json'));
    const json = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(json).toEqual({
      mcpServers: {
        symphony: {
          command: '/abs/node',
          args: ['/abs/path/to/dist/index.js', 'mcp-server'],
          env: {},
        },
      },
    });
  });

  it('appends --in-memory when inMemory=true', async () => {
    const result = await writeMaestroMcpConfig({
      cwd: sandbox,
      cliEntryPath: '/cli',
      nodeBinary: '/node',
      inMemory: true,
    });
    const json = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(json.mcpServers.symphony.args).toEqual(['/cli', 'mcp-server', '--in-memory']);
  });

  it('honors an explicit outputPath', async () => {
    const target = join(sandbox, 'nested', 'mcp.json');
    rmSync(join(sandbox, 'nested'), { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(sandbox, 'nested'), { recursive: true });
    const result = await writeMaestroMcpConfig({
      cwd: sandbox,
      cliEntryPath: '/cli',
      nodeBinary: '/node',
      outputPath: target,
    });
    expect(result.path).toBe(target);
    expect(readFileSync(target, 'utf8')).toContain('"symphony"');
  });

  it('atomically writes — no .tmp leak on success', async () => {
    await writeMaestroMcpConfig({
      cwd: sandbox,
      cliEntryPath: '/cli',
      nodeBinary: '/node',
    });
    const leftovers = readdirSync(sandbox).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('merges extraServers alongside symphony', async () => {
    const result = await writeMaestroMcpConfig({
      cwd: sandbox,
      cliEntryPath: '/cli',
      nodeBinary: '/node',
      extraServers: {
        memory: { command: '/usr/bin/memory-server', args: ['--port', '0'] },
      },
    });
    const json = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(json.mcpServers.symphony).toBeDefined();
    expect(json.mcpServers.memory).toEqual({
      command: '/usr/bin/memory-server',
      args: ['--port', '0'],
    });
  });

  it('defaults nodeBinary to process.execPath', async () => {
    const result = await writeMaestroMcpConfig({
      cwd: sandbox,
      cliEntryPath: '/cli',
    });
    const json = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(json.mcpServers.symphony.command).toBe(process.execPath);
  });

  it('prepends `--import tsx` when cliEntryPath is a .ts file (dev mode)', async () => {
    const result = await writeMaestroMcpConfig({
      cwd: sandbox,
      cliEntryPath: '/repo/src/index.ts',
      nodeBinary: '/abs/node',
    });
    const json = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(json.mcpServers.symphony.args).toEqual([
      '--import',
      'tsx',
      '/repo/src/index.ts',
      'mcp-server',
    ]);
  });

  it('keeps args verbatim when cliEntryPath is a .js file (production)', async () => {
    const result = await writeMaestroMcpConfig({
      cwd: sandbox,
      cliEntryPath: '/abs/dist/index.js',
      nodeBinary: '/abs/node',
    });
    const json = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(json.mcpServers.symphony.args).toEqual(['/abs/dist/index.js', 'mcp-server']);
  });
});
