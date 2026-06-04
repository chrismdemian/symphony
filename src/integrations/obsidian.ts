import matter from 'gray-matter';
import path from 'node:path';
import { isTerminalStatus, type TaskStatus } from '../state/types.js';
import {
  loadObsidianConfig,
  resolveStatusMap,
  type ObsidianConfig,
} from './obsidian-config.js';
import {
  bodyStartLine,
  parseTasksFromBody,
  rewriteTaskLineStatus,
  type StatusClassification,
  type TaskFormat,
} from './obsidian-parser.js';
import { createVaultFs, type VaultFsLike } from './obsidian-vault.js';

/**
 * Phase 8B — the in-tree Obsidian connector. Owns all vault I/O behind the
 * `VaultFsLike` seam; produces `ObsidianTaskCandidate`s for the
 * `sync_obsidian` tool (and the live watcher) to turn into Symphony tasks,
 * and pushes terminal task statuses back by FLIPPING THE CHECKBOX in the
 * source markdown.
 *
 * Like the Notion connector it does NOT touch Symphony state — task creation
 * + external-link persistence are mediated by the tool / server (single-writer
 * principle). The connector is pure vault: read markdown → candidates, and
 * task-id → checkbox rewrite.
 *
 * Stable identity: a candidate's `externalId` is `<vault-relative-path>#<locator>`
 * where locator prefers a Tasks `🆔 id`, then a `^blockid`, then a content
 * hash of the description (see `obsidian-parser`). Writeback re-derives each
 * line's locator to find the exact line to flip — robust against edits
 * elsewhere in the file.
 */

export interface ObsidianTaskCandidate {
  /** `<vault-relative-posix-path>#<locator>` — the external-link key. */
  readonly externalId: string;
  /** `obsidian://` URI (chat / audit display; stored on the link). */
  readonly url: string;
  /** Cleaned task text → Symphony task description. */
  readonly title: string;
  /**
   * Mapped Symphony status. Used by the tool to SKIP tasks already in a
   * terminal Obsidian state (done `[x]` / cancelled `[-]`) — don't import
   * finished work. Open tasks are created `pending` (the store forces it).
   */
  readonly status: TaskStatus;
  /** Mapped integer priority (0 for unmarked). */
  readonly priority: number;
  /** Frontmatter project-property value (tool resolves to a Symphony project). */
  readonly projectValue: string | null;
}

export interface ObsidianWritebackResult {
  readonly written: boolean;
  /** The Obsidian status char written (when `written`). */
  readonly value?: string;
  /** Why nothing was written (no `failed` char configured, line not found). */
  readonly reason?: string;
  /**
   * Discriminates the non-written cases so callers log appropriately:
   *   - `skipped`   — expected no-op (no char configured / already at target)
   *   - `not-found` — the task line is gone/edited (locator drift) — a real miss
   *   - `error`     — malformed id / read / write failure
   * Absent when `written` is true.
   */
  readonly code?: 'skipped' | 'not-found' | 'error';
}

export interface ObsidianVaultCheck {
  readonly ok: boolean;
  readonly fileCount?: number;
  readonly openTaskCount?: number;
  readonly reason?: string;
}

export interface ObsidianConnectorHandle {
  /**
   * ALL task candidates across the vault (open AND terminal), capped at
   * `limit`. Mirrors Notion's `fetchOpenPages`: the ingest skips terminal
   * ones (counting `skippedDone`); the connector doesn't pre-filter.
   */
  fetchOpenTasks(opts?: {
    readonly limit?: number;
  }): Promise<readonly ObsidianTaskCandidate[]>;
  /** All task candidates in a single vault-relative file (watcher path). */
  fetchTasksInFile(relPath: string): Promise<readonly ObsidianTaskCandidate[]>;
  writeBackStatus(
    externalId: string,
    status: 'completed' | 'failed',
  ): Promise<ObsidianWritebackResult>;
  /** Vault sanity probe for the CLI `--status` check. */
  checkVault(): Promise<ObsidianVaultCheck>;
}

export interface ObsidianConnectorDeps {
  readonly vault: VaultFsLike;
  readonly config: ObsidianConfig;
  /** Optional structured logger (defaults to no-op — TUI owns stdout). */
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Clock seam for the `✅ <date>` done stamp + tests. */
  readonly now?: () => number;
  /** Default task cap when `fetchOpenTasks` is called without a limit. */
  readonly defaultFetchLimit?: number;
}

export class ObsidianError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObsidianError';
  }
}

const DEFAULT_FETCH_LIMIT = 200;

export class ObsidianConnector implements ObsidianConnectorHandle {
  private readonly vault: VaultFsLike;
  private readonly config: ObsidianConfig;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly now: () => number;
  private readonly defaultFetchLimit: number;
  private readonly statusMap: Record<string, StatusClassification>;

  constructor(deps: ObsidianConnectorDeps) {
    this.vault = deps.vault;
    this.config = deps.config;
    this.log = deps.log ?? (() => undefined);
    this.now = deps.now ?? Date.now;
    this.defaultFetchLimit = deps.defaultFetchLimit ?? DEFAULT_FETCH_LIMIT;
    this.statusMap = resolveStatusMap(deps.config);
  }

  async fetchOpenTasks(
    opts: { readonly limit?: number } = {},
  ): Promise<readonly ObsidianTaskCandidate[]> {
    const limit = opts.limit ?? this.defaultFetchLimit;
    const files = await this.vault.listMarkdownFiles();
    const out: ObsidianTaskCandidate[] = [];
    for (const relPath of files) {
      if (out.length >= limit) break;
      let candidates: readonly ObsidianTaskCandidate[];
      try {
        candidates = await this.parseFile(relPath);
      } catch (err) {
        this.log(
          'warn',
          `failed to read ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      for (const c of candidates) {
        out.push(c);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async fetchTasksInFile(relPath: string): Promise<readonly ObsidianTaskCandidate[]> {
    return this.parseFile(relPath);
  }

  /**
   * Parse one vault file → ALL its task candidates (open AND terminal).
   * Mirrors Notion's `fetchOpenPages` contract: the connector returns every
   * candidate and the INGEST (`obsidian-ingest`) skips terminal ones, counting
   * them as `skippedDone`. Keeping the terminal-skip in one place (the ingest)
   * means the watcher's loop-safety and the tool's "N done" count share it.
   */
  private async parseFile(relPath: string): Promise<readonly ObsidianTaskCandidate[]> {
    const raw = await this.vault.readFile(relPath);
    const { data, content } = matter(raw);
    const projectValue = readFrontmatterString(data, this.config.projectProperty);
    const tasks = parseTasksFromBody(content, {
      format: this.config.taskFormat,
      statusMap: this.statusMap,
    });
    const url = this.obsidianUri(relPath);
    return tasks.map((t) => ({
      externalId: `${relPath}#${t.locator}`,
      url,
      title: t.description,
      status: t.status,
      priority: t.priority,
      projectValue,
    }));
  }

  async writeBackStatus(
    externalId: string,
    status: 'completed' | 'failed',
  ): Promise<ObsidianWritebackResult> {
    const targetChar =
      status === 'completed'
        ? this.config.statusWriteback.completed
        : this.config.statusWriteback.failed;
    if (targetChar === undefined) {
      return {
        written: false,
        code: 'skipped',
        reason: `no '${status}' writeback char configured`,
      };
    }
    const parsed = splitExternalId(externalId);
    if (parsed === undefined) {
      return { written: false, code: 'error', reason: `malformed external id: ${externalId}` };
    }
    const { relPath, locator } = parsed;

    let raw: string;
    try {
      raw = await this.vault.readFile(relPath);
    } catch (err) {
      return {
        written: false,
        code: 'error',
        reason: `cannot read ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const lines = raw.split(/\r?\n/u);
    const matchIdx = this.findLineByLocator(lines, locator);
    const matchedLine = matchIdx === -1 ? undefined : lines[matchIdx];
    if (matchIdx === -1 || matchedLine === undefined) {
      return { written: false, code: 'not-found', reason: `task line not found for locator ${locator}` };
    }

    const doneDate =
      status === 'completed' && this.config.statusWriteback.appendDoneDate
        ? new Date(this.now()).toISOString().slice(0, 10)
        : undefined;
    const rewritten = rewriteTaskLineStatus(matchedLine, targetChar, {
      ...(doneDate !== undefined ? { doneDate } : {}),
    });
    if (rewritten === undefined) {
      // Already at the target char with nothing to add — idempotent no-op.
      return { written: false, code: 'skipped', reason: 'line already at target status' };
    }
    // Surgical splice: replace ONLY the matched line's content, leaving every
    // other byte (including each line's own terminator and a trailing newline)
    // exactly as-is. A split/join would normalize the whole file's EOLs — a
    // noisy, unwanted diff in the user's vault.
    const next = spliceLineContent(raw, matchIdx, rewritten);
    try {
      await this.vault.writeFile(relPath, next);
    } catch (err) {
      return {
        written: false,
        code: 'error',
        reason: `write failed for ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { written: true, value: targetChar };
  }

  async checkVault(): Promise<ObsidianVaultCheck> {
    if (!(await this.vault.isVault())) {
      return { ok: false, reason: `vault path is not a directory: ${this.vault.root}` };
    }
    const files = await this.vault.listMarkdownFiles();
    const candidates = await this.fetchOpenTasks({ limit: this.defaultFetchLimit });
    const openTaskCount = candidates.filter((c) => !isTerminalStatus(c.status)).length;
    return { ok: true, fileCount: files.length, openTaskCount };
  }

  /**
   * Find the RAW line index of the task whose locator equals `target`. Scans
   * ONLY the body (frontmatter skipped) using the exact same `parseTasksFromBody`
   * pass fetch uses — so the fetch and writeback paths agree on the task-line
   * set, the ordinal disambiguation, and the fence handling (audit M1/M2/m3). A
   * `- [ ]`-shaped line inside YAML frontmatter is therefore never matched.
   * Returns -1 when no body task carries `target`.
   */
  private findLineByLocator(lines: readonly string[], target: string): number {
    const bodyStart = bodyStartLine(lines);
    const body = lines.slice(bodyStart).join('\n');
    const tasks = parseTasksFromBody(body, {
      format: this.config.taskFormat,
      statusMap: this.statusMap,
    });
    const match = tasks.find((t) => t.locator === target);
    return match === undefined ? -1 : bodyStart + match.lineIndex;
  }

  private obsidianUri(relPath: string): string {
    const vaultName = path.basename(this.vault.root);
    const fileNoExt = relPath.replace(/\.md$/iu, '');
    return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(fileNoExt)}`;
  }
}

/**
 * Replace the CONTENT of line `lineIndex` (0-based, lines split on `\n` with an
 * optional preceding `\r`) in `raw`, preserving every terminator and trailing
 * newline byte-for-byte. Line numbering matches `raw.split(/\r?\n/)`. Returns
 * `raw` unchanged when `lineIndex` is out of range.
 */
function spliceLineContent(raw: string, lineIndex: number, newContent: string): string {
  let start = 0;
  let line = 0;
  for (let i = 0; i <= raw.length; i += 1) {
    if (i === raw.length || raw[i] === '\n') {
      if (line === lineIndex) {
        // Exclude a trailing `\r` from the content range (CRLF terminator).
        let end = i;
        if (end > start && raw[end - 1] === '\r') end -= 1;
        return raw.slice(0, start) + newContent + raw.slice(end);
      }
      line += 1;
      start = i + 1;
    }
  }
  return raw;
}

/** Read a frontmatter value as a trimmed string, or null when absent/non-scalar. */
function readFrontmatterString(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const v = data[key];
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** Split `<relPath>#<locator>` on the LAST `#` (locators never contain `#`). */
function splitExternalId(
  externalId: string,
): { relPath: string; locator: string } | undefined {
  const hash = externalId.lastIndexOf('#');
  if (hash <= 0 || hash === externalId.length - 1) return undefined;
  return {
    relPath: externalId.slice(0, hash),
    locator: externalId.slice(hash + 1),
  };
}

/**
 * Build an `ObsidianConnector` from on-disk config, or return `undefined` when
 * Obsidian isn't configured (no `obsidian.json`). Used by the orchestrator
 * server to auto-activate the connector when the user has run
 * `symphony config obsidian`. Throws on a present-but-malformed config (via
 * `loadObsidianConfig`) — a misconfigured integration must surface.
 */
export async function createObsidianConnectorFromDisk(
  opts: {
    readonly home?: string;
    readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
    readonly now?: () => number;
  } = {},
): Promise<ObsidianConnector | undefined> {
  const config = await loadObsidianConfig(opts.home);
  if (config === undefined) return undefined;
  const vault = createVaultFs(config.vaultPath, { exclude: config.exclude });
  return new ObsidianConnector({
    vault,
    config,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}

export type { TaskFormat };
