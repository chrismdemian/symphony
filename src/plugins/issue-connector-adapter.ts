import { z } from 'zod';

import type {
  IssueConnectorHandle,
  IssueWritebackResult,
  NormalizedIssue,
} from '../integrations/issue-connector.js';
import type { PluginCallResult } from './client.js';

/**
 * Phase 9A — wrap a sandboxed issue-source PLUGIN as an in-tree
 * `IssueConnectorHandle`, so the existing ingest + writeback pipeline
 * (`ingestIssueCandidates`, `makeSyncIssuesTool`, `makeIssueWritebackRef`,
 * `task_external_links`) works against a plugin with ZERO new surface.
 *
 * The plugin stays a pure MCP server: it exposes two tools the adapter
 * calls — `fetch_open_issues` and `write_back_status` (+ optional
 * `search_issues` / `check_connection`). The HOST keeps owning TaskStore +
 * the link table; the plugin owns only the external-API logic + its own
 * secrets. No plugin→host reverse channel.
 *
 * The adapter calls the plugin's tools DIRECTLY via the `PluginClient`
 * (`IssueSourceToolCaller`), NOT through the registered MCP proxy /
 * `wrapToolHandler` — that path is for Maestro-initiated calls; fetch +
 * writeback are host-initiated (the `sync_<source>` tool the adapter feeds
 * already flows through `wrapToolHandler`; writeback intentionally bypasses
 * the Tier-2 floor like every in-tree connector, see `makeIssueWritebackRef`).
 *
 * The plugin's `structuredContent` is UNTRUSTED — every result is
 * zod-validated before it reaches `ingestIssueCandidates`. A malformed
 * issue is dropped (logged), never aborts the batch (8C ingest philosophy);
 * a malformed writeback result becomes a `code: 'error'` (observable).
 */

/** The conventional tool names an issue-source plugin exposes. */
export const ISSUE_SOURCE_TOOL_NAMES = {
  fetchOpenIssues: 'fetch_open_issues',
  searchIssues: 'search_issues',
  writeBackStatus: 'write_back_status',
  checkConnection: 'check_connection',
} as const;

/**
 * The host keeps these tool names OUT of Maestro's toolbelt for an
 * issue-source plugin — the adapter consumes them internally, exactly as
 * `on_<event>` handler tools are kept out (Phase 7B.3). Maestro sees only
 * the single `sync_<source>` tool.
 */
export const ISSUE_SOURCE_INTERNAL_TOOLS: ReadonlySet<string> = new Set(
  Object.values(ISSUE_SOURCE_TOOL_NAMES),
);

/** Minimal slice of `PluginClient` the adapter needs — keeps tests fakeable. */
export interface IssueSourceToolCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<PluginCallResult>;
}

// Bounds on UNTRUSTED plugin output. `externalId` is the link key — an
// absurdly long one is broken/adversarial → reject the issue. `title`
// becomes the task description (which the ingest path doesn't cap), so cap
// it defensively by truncation rather than dropping an otherwise-valid issue.
const MAX_EXTERNAL_ID = 512;
const MAX_TITLE = 2000;

const NormalizedIssueSchema = z.object({
  externalId: z.string().min(1).max(MAX_EXTERNAL_ID),
  title: z.string().transform((t) => (t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t)),
  url: z.string().nullable().catch(null).default(null),
  state: z.string().nullable().catch(null).default(null),
  isTerminal: z.boolean(),
  body: z.string().nullable().catch(null).default(null),
  assignee: z.string().nullable().catch(null).default(null),
  labels: z.array(z.string()).catch([]).default([]),
  projectValue: z.string().nullable().catch(null).default(null),
  priority: z.number().int().catch(0).default(0),
  updatedAt: z.string().nullable().catch(null).default(null),
});

const FetchResultSchema = z.object({
  issues: z.array(z.unknown()).default([]),
});

const WritebackResultSchema = z.object({
  written: z.boolean(),
  code: z.enum(['written', 'skipped', 'not-found', 'error']),
  value: z.string().optional(),
  reason: z.string().optional(),
});

const CheckConnectionSchema = z.object({
  ok: z.boolean(),
  detail: z.string().optional(),
});

export interface PluginIssueConnectorAdapterDeps {
  /** The `task_external_links.source` id (from `manifest.provides.issueSource.source`). */
  readonly source: string;
  /** The plugin client (or any compatible tool caller). */
  readonly client: IssueSourceToolCaller;
  /** Diagnostic sink; defaults to no-op. */
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /**
   * Phase 9B seam — when set, the host polls `fetch_open_issues` on this
   * interval (replacing a push-source watcher, e.g. Obsidian). Declared but
   * INERT in 9A (the host does not yet read it; `sync_<source>` is the only
   * trigger).
   */
  readonly pollIntervalMs?: number;
}

export class PluginIssueConnectorAdapter implements IssueConnectorHandle {
  readonly source: string;
  /** Phase 9B — host-side polling interval (inert in 9A). */
  readonly pollIntervalMs?: number;
  private readonly client: IssueSourceToolCaller;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;

  constructor(deps: PluginIssueConnectorAdapterDeps) {
    this.source = deps.source;
    this.client = deps.client;
    this.log = deps.log ?? ((): void => undefined);
    if (deps.pollIntervalMs !== undefined) this.pollIntervalMs = deps.pollIntervalMs;
  }

  async fetchOpenIssues(
    opts: { readonly limit?: number } = {},
  ): Promise<readonly NormalizedIssue[]> {
    const res = await this.client.callTool(
      ISSUE_SOURCE_TOOL_NAMES.fetchOpenIssues,
      opts.limit !== undefined ? { limit: opts.limit } : {},
    );
    if (res.isError) {
      throw new Error(`plugin '${this.source}' fetch_open_issues failed: ${errorText(res)}`);
    }
    return this.parseIssues(res.structuredContent);
  }

  async searchIssues(
    term: string,
    opts: { readonly limit?: number } = {},
  ): Promise<readonly NormalizedIssue[]> {
    const res = await this.client.callTool(ISSUE_SOURCE_TOOL_NAMES.searchIssues, {
      term,
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    });
    if (res.isError) {
      throw new Error(`plugin '${this.source}' search_issues failed: ${errorText(res)}`);
    }
    return this.parseIssues(res.structuredContent);
  }

  async writeBackStatus(
    externalId: string,
    status: 'completed' | 'failed',
  ): Promise<IssueWritebackResult> {
    let res: PluginCallResult;
    try {
      res = await this.client.callTool(ISSUE_SOURCE_TOOL_NAMES.writeBackStatus, {
        externalId,
        status,
      });
    } catch (err) {
      return { written: false, code: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
    if (res.isError) {
      return { written: false, code: 'error', reason: errorText(res) };
    }
    const parsed = WritebackResultSchema.safeParse(res.structuredContent);
    if (!parsed.success) {
      return {
        written: false,
        code: 'error',
        reason: `malformed writeback result from plugin '${this.source}'`,
      };
    }
    return parsed.data;
  }

  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    let res: PluginCallResult;
    try {
      res = await this.client.callTool(ISSUE_SOURCE_TOOL_NAMES.checkConnection, {});
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
    if (res.isError) return { ok: false, detail: errorText(res) };
    const parsed = CheckConnectionSchema.safeParse(res.structuredContent);
    if (!parsed.success) {
      return { ok: false, detail: `malformed check_connection result from plugin '${this.source}'` };
    }
    return parsed.data.detail !== undefined
      ? { ok: parsed.data.ok, detail: parsed.data.detail }
      : { ok: parsed.data.ok };
  }

  /** Validate the untrusted `{ issues: [...] }` payload; drop malformed entries. */
  private parseIssues(structuredContent: Record<string, unknown> | undefined): NormalizedIssue[] {
    const envelope = FetchResultSchema.safeParse(structuredContent ?? {});
    if (!envelope.success) {
      this.log('warn', `plugin '${this.source}' returned a malformed fetch payload — treating as empty`);
      return [];
    }
    const out: NormalizedIssue[] = [];
    let dropped = 0;
    for (const raw of envelope.data.issues) {
      const parsed = NormalizedIssueSchema.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
      else dropped += 1;
    }
    if (dropped > 0) {
      this.log('warn', `plugin '${this.source}' returned ${dropped} malformed issue(s) — dropped`);
    }
    return out;
  }
}

function errorText(res: PluginCallResult): string {
  const text = res.content
    .map((c) => c.text)
    .filter((t) => t.length > 0)
    .join(' ');
  if (text.length === 0) return 'plugin returned an error result';
  // Bound an adversarial plugin's error blocks (mirrors the example plugin's
  // own 300-char body slice).
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
