import matter from 'gray-matter';
import path from 'node:path';

import { resolveStatusMap, type ObsidianSourceConfig } from './config.js';
import {
  bodyStartLine,
  parseTasksFromBody,
  rewriteTaskLineStatus,
  type StatusClassification,
} from './parser.js';
import { createVaultFs, type VaultFsLike } from './vault.js';

/**
 * obsidian-source — the connector. Ported from Symphony's in-tree
 * `src/integrations/obsidian.ts`. Reads markdown → `NormalizedIssue[]`, and
 * flips the source checkbox on terminal-status writeback.
 *
 * The in-tree connector ran a live chokidar watcher; a sandboxed plugin can't
 * PUSH to the host (no reverse channel), so the manifest declares
 * `pollIntervalMs` and the host pulls `fetch_open_issues` on that cadence
 * instead. Everything else — parse, locator round-trip, byte-preserving
 * writeback splice — is identical.
 */

export interface NormalizedIssue {
  externalId: string;
  title: string;
  url: string | null;
  state: string | null;
  isTerminal: boolean;
  body: string | null;
  assignee: string | null;
  labels: string[];
  projectValue: string | null;
  priority: number;
  updatedAt: string | null;
}

export interface WritebackResult {
  written: boolean;
  code: 'written' | 'skipped' | 'not-found' | 'error';
  value?: string;
  reason?: string;
}

export interface ObsidianSourceDeps {
  /** Override the vault fs seam (tests). Defaults to a real fs vault. */
  readonly vault?: VaultFsLike;
  /** Clock seam for the `✅ <date>` done stamp + tests. */
  readonly now?: () => number;
  readonly defaultFetchLimit?: number;
}

const DEFAULT_FETCH_LIMIT = 200;

export class ObsidianSource {
  private readonly vault: VaultFsLike;
  private readonly config: ObsidianSourceConfig;
  private readonly now: () => number;
  private readonly defaultFetchLimit: number;
  private readonly statusMap: Record<string, StatusClassification>;

  constructor(config: ObsidianSourceConfig, deps: ObsidianSourceDeps = {}) {
    this.config = config;
    this.vault = deps.vault ?? createVaultFs(config.vaultPath, { exclude: config.exclude });
    this.now = deps.now ?? Date.now;
    this.defaultFetchLimit = deps.defaultFetchLimit ?? DEFAULT_FETCH_LIMIT;
    this.statusMap = resolveStatusMap(config);
  }

  /** Fetch ALL task candidates (open AND terminal); the ingest skips terminal. */
  async fetchOpenIssues(limit?: number): Promise<NormalizedIssue[]> {
    const cap = limit ?? this.defaultFetchLimit;
    const files = await this.vault.listMarkdownFiles();
    const out: NormalizedIssue[] = [];
    for (const relPath of files) {
      if (out.length >= cap) break;
      let candidates: NormalizedIssue[];
      try {
        candidates = await this.parseFile(relPath);
      } catch (err) {
        process.stderr.write(
          `[obsidian-source] failed to read ${relPath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        continue;
      }
      for (const c of candidates) {
        out.push(c);
        if (out.length >= cap) break;
      }
    }
    return out;
  }

  private async parseFile(relPath: string): Promise<NormalizedIssue[]> {
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
      title: t.description,
      url,
      state: t.statusChar,
      isTerminal: t.terminal,
      body: null,
      assignee: null,
      labels: [],
      projectValue,
      priority: t.priority,
      updatedAt: null,
    }));
  }

  async writeBack(externalId: string, status: 'completed' | 'failed'): Promise<WritebackResult> {
    const targetChar =
      status === 'completed'
        ? this.config.statusWriteback.completed
        : this.config.statusWriteback.failed;
    if (targetChar === undefined) {
      return { written: false, code: 'skipped', reason: `no '${status}' writeback char configured` };
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
      return { written: false, code: 'skipped', reason: 'line already at target status' };
    }
    // Surgical splice: replace ONLY the matched line's content, preserving every
    // other byte (incl. each line's terminator). A split/join would normalize
    // the whole file's EOLs — a noisy, unwanted diff in the user's vault.
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
    return { written: true, code: 'written', value: targetChar };
  }

  async checkConnection(): Promise<{ ok: boolean; detail?: string }> {
    if (!(await this.vault.isVault())) {
      return { ok: false, detail: `vault path is not a directory: ${this.vault.root}` };
    }
    const files = await this.vault.listMarkdownFiles();
    return { ok: true, detail: `vault OK — ${files.length} markdown file(s)` };
  }

  /**
   * Find the RAW line index of the task whose locator equals `target`. Scans
   * ONLY the body (frontmatter skipped) using the same `parseTasksFromBody`
   * pass fetch uses — so fetch + writeback agree on the task-line set, the
   * ordinal disambiguation, and fence handling (8B audit M1/M2). A `- [ ]`-
   * shaped line inside YAML frontmatter is therefore never matched.
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
 * Replace the CONTENT of line `lineIndex` in `raw`, preserving every
 * terminator + trailing newline byte-for-byte. Line numbering matches
 * `raw.split(/\r?\n/)`. Returns `raw` unchanged when `lineIndex` is out of range.
 */
function spliceLineContent(raw: string, lineIndex: number, newContent: string): string {
  let start = 0;
  let line = 0;
  for (let i = 0; i <= raw.length; i += 1) {
    if (i === raw.length || raw[i] === '\n') {
      if (line === lineIndex) {
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

function readFrontmatterString(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/** Split `<relPath>#<locator>` on the LAST `#` (locators never contain `#`). */
function splitExternalId(externalId: string): { relPath: string; locator: string } | undefined {
  const hash = externalId.lastIndexOf('#');
  if (hash <= 0 || hash === externalId.length - 1) return undefined;
  return { relPath: externalId.slice(0, hash), locator: externalId.slice(hash + 1) };
}
