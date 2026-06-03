import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { PLUGIN_API_VERSION } from './manifest.js';

/**
 * Phase 7A — PluginClient: Symphony as an MCP *client* to a single plugin
 * subprocess.
 *
 * This is the first place Symphony acts as an MCP client (it is the MCP
 * server everywhere else). `StdioClientTransport` spawns the plugin's
 * entrypoint process and speaks MCP over its stdio; `Client` does the
 * handshake + tool calls. The host (`host.ts`) owns one PluginClient per
 * enabled plugin and re-registers each discovered tool as a namespaced
 * proxy in Symphony's own `ToolRegistry`, so every Maestro→plugin call
 * still flows through `wrapToolHandler` (capability + audit enforcement).
 *
 * Lifecycle mirrors `voice/bridge.ts`: spawn → ready → closed/crashed.
 * A crash sets state and rejects in-flight calls; the host isolates it so
 * one plugin dying never tanks Symphony or its siblings.
 */

export type PluginClientState = 'idle' | 'connecting' | 'ready' | 'closed' | 'crashed';

export interface PluginToolDescriptor {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema for the tool's input (MCP `inputSchema`). */
  readonly inputSchema: unknown;
}

export interface PluginClientOptions {
  readonly id: string;
  /** Absolute install dir — becomes the subprocess cwd. */
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Optional stderr sink; defaults to a `[plugin:<id>]`-prefixed process.stderr. */
  readonly onStderr?: (chunk: string) => void;
  /** Test seam — inject a transport/client factory. */
  readonly factory?: PluginClientFactory;
}

/** Minimal surface the host depends on — lets tests fake the transport. */
export interface PluginClientConnection {
  connect(): Promise<void>;
  listTools(): Promise<PluginToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<PluginCallResult>;
  close(): Promise<void>;
  onClose(cb: () => void): void;
}

export interface PluginCallResult {
  readonly content: Array<{ type: 'text'; text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError: boolean;
}

export type PluginClientFactory = (opts: PluginClientOptions) => PluginClientConnection;

/**
 * Strict env allowlist for plugin subprocesses (emdash/voice precedent:
 * build env from scratch, never inherit packaged-binary artifacts or
 * Symphony/cloud secrets). Win32 needs PATHEXT/SystemRoot/ComSpec/
 * LOCALAPPDATA to resolve + run executables. SYMPHONY_, ANTHROPIC_, AWS_,
 * GH_ vars are absent by construction — a plugin gets a clean env and
 * sources its own secrets via its own config (Phase 8C keychain), never
 * Symphony's.
 */
const ENV_ALLOWLIST_COMMON = ['PATH', 'LANG', 'LC_ALL', 'TZ'];
const ENV_ALLOWLIST_POSIX = ['HOME', 'USER', 'SHELL', 'TMPDIR'];
const ENV_ALLOWLIST_WIN32 = [
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'ComSpec',
  'LOCALAPPDATA',
  'APPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

export function buildPluginEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keys =
    process.platform === 'win32'
      ? [...ENV_ALLOWLIST_COMMON, ...ENV_ALLOWLIST_WIN32]
      : [...ENV_ALLOWLIST_COMMON, ...ENV_ALLOWLIST_POSIX];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Default production connection backed by the real MCP stdio client. */
function defaultConnection(opts: PluginClientOptions): PluginClientConnection {
  const onStderr =
    opts.onStderr ??
    ((chunk: string): void => {
      if (process.stderr.writable) process.stderr.write(`[plugin:${opts.id}] ${chunk}`);
    });

  // Resolve a relative command against the install dir; pass PATH names
  // (node/python) through verbatim.
  const command =
    opts.command.includes('/') || opts.command.includes('\\') || path.isAbsolute(opts.command)
      ? path.resolve(opts.cwd, opts.command)
      : opts.command;

  const transport = new StdioClientTransport({
    command,
    args: [...opts.args],
    cwd: opts.cwd,
    env: buildPluginEnv(),
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'symphony-plugin-host', version: PLUGIN_API_VERSION },
    { capabilities: {} },
  );

  let closeCb: (() => void) | undefined;

  return {
    async connect(): Promise<void> {
      await client.connect(transport);
      // Pipe plugin stderr with a prefix (worker-stderr precedent).
      const stderr = transport.stderr;
      if (stderr !== null) {
        stderr.on('data', (buf: Buffer) => onStderr(buf.toString('utf8')));
      }
      transport.onclose = (): void => {
        closeCb?.();
      };
    },
    async listTools(): Promise<PluginToolDescriptor[]> {
      const result = await client.listTools();
      return result.tools.map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.inputSchema,
      }));
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<PluginCallResult> {
      const raw = await client.callTool({ name, arguments: args }, CallToolResultSchema);
      return normalizeCallResult(raw);
    },
    async close(): Promise<void> {
      await client.close();
    },
    onClose(cb: () => void): void {
      closeCb = cb;
    },
  };
}

/** Flatten an MCP CallToolResult into the host's text-centric shape. */
function normalizeCallResult(raw: unknown): PluginCallResult {
  const obj = (raw ?? {}) as {
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  const content: Array<{ type: 'text'; text: string }> = [];
  for (const block of obj.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text });
    } else {
      // Non-text blocks (image/audio/resource) are summarized for the
      // text-only host surface in v1.
      content.push({ type: 'text', text: `[${block.type ?? 'unknown'} content omitted]` });
    }
  }
  return {
    content,
    ...(obj.structuredContent !== undefined ? { structuredContent: obj.structuredContent } : {}),
    isError: obj.isError === true,
  };
}

export class PluginClient {
  private state: PluginClientState = 'idle';
  private readonly conn: PluginClientConnection;
  private tools: PluginToolDescriptor[] = [];
  private closing = false;

  constructor(private readonly opts: PluginClientOptions) {
    const factory = opts.factory ?? defaultConnection;
    this.conn = factory(opts);
    this.conn.onClose(() => {
      // Unexpected close after ready (and not during our own close) is a crash.
      if (!this.closing && this.state === 'ready') {
        this.state = 'crashed';
      }
    });
  }

  get id(): string {
    return this.opts.id;
  }

  getState(): PluginClientState {
    return this.state;
  }

  listToolDescriptors(): readonly PluginToolDescriptor[] {
    return this.tools;
  }

  /** Spawn + handshake + discover tools. Throws on failure (host isolates). */
  async start(): Promise<readonly PluginToolDescriptor[]> {
    this.state = 'connecting';
    try {
      await this.conn.connect();
      this.tools = await this.conn.listTools();
      this.state = 'ready';
      return this.tools;
    } catch (err) {
      this.state = 'crashed';
      // Audit M1 — the connect-ok-then-listTools-fails path: the
      // subprocess was already spawned by the transport, but this client
      // is discarded by the host (never added to `loaded`), so its child
      // would orphan. Best-effort close before rethrow.
      this.closing = true;
      await this.conn.close().catch(() => {});
      throw err;
    }
  }

  /**
   * Forward a tool call to the plugin. Returns an error result (never
   * throws) when the plugin is not ready or the call fails — the proxy
   * tool surfaces it to Maestro as `isError`.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<PluginCallResult> {
    if (this.state !== 'ready') {
      return {
        content: [{ type: 'text', text: `plugin '${this.opts.id}' is not ready (${this.state})` }],
        isError: true,
      };
    }
    try {
      return await this.conn.callTool(name, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `plugin '${this.opts.id}' call '${name}' failed: ${message}` }],
        isError: true,
      };
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.state === 'closed') return;
    try {
      await this.conn.close();
    } catch {
      // best-effort teardown
    } finally {
      this.state = 'closed';
    }
  }
}
