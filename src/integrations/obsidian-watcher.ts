import path from 'node:path';
import chokidar from 'chokidar';
import {
  ingestObsidianCandidates,
  type ObsidianIngestDeps,
  type ObsidianIngestResult,
} from './obsidian-ingest.js';
import type { ObsidianConnectorHandle } from './obsidian.js';

/**
 * Phase 8B — live vault watcher. Watches the Obsidian vault with chokidar and,
 * on a markdown file `add`/`change`, re-parses that ONE file and ingests its
 * new open tasks (reusing the same connector + ingest core as `sync_obsidian`).
 *
 * Boot semantics: `ignoreInitial: true` — the watcher does NOT bulk-import the
 * whole vault on start (that's `sync_obsidian`'s job). It only catches tasks
 * ADDED/edited after boot. This mirrors how 8A's continuous polling was
 * deferred: the explicit sync seeds, the watcher tops up.
 *
 * Loop-safety: the writeback hook flips a checkbox in a note, which fires a
 * chokidar `change`. That re-parse is a no-op because the flipped line is now
 * terminal (`[x]`/`[-]` → skipped) AND already linked (dedup). `awaitWriteFinish`
 * coalesces the tmp+rename write so the watcher sees one stable event.
 */

/** The slice of chokidar's `FSWatcher` we use (injectable for tests). */
export interface FSWatcherLike {
  on(event: 'add' | 'change', listener: (filePath: string) => void): this;
  on(event: 'error', listener: (err: unknown) => void): this;
  on(event: 'ready', listener: () => void): this;
  close(): Promise<void>;
}

export type WatchFactory = (root: string, ignored: (p: string, stats?: { isFile(): boolean }) => boolean) => FSWatcherLike;

export interface ObsidianWatcherDeps extends ObsidianIngestDeps {
  readonly connector: ObsidianConnectorHandle;
  readonly vaultRoot: string;
  readonly exclude: readonly string[];
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** Per-file debounce window (ms) coalescing rapid editor saves. Default 300. */
  readonly debounceMs?: number;
  /** Inject a watcher factory (tests). Defaults to a real chokidar watcher. */
  readonly watchFactory?: WatchFactory;
  /** Fired after each file's ingest (logging / notification seam). */
  readonly onIngest?: (relPath: string, result: ObsidianIngestResult) => void;
  /**
   * Fired once when the initial scan completes (chokidar `ready`). After this
   * point `ignoreInitial` means only NEW files/edits emit events — tests gate
   * their first write on this so it isn't swallowed as part of the initial scan.
   */
  readonly onReady?: () => void;
}

const DEFAULT_DEBOUNCE_MS = 300;

export class ObsidianVaultWatcher {
  private readonly deps: ObsidianWatcherDeps;
  private readonly root: string;
  private readonly debounceMs: number;
  private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private watcher: FSWatcherLike | undefined;
  private disposed = false;

  constructor(deps: ObsidianWatcherDeps) {
    this.deps = deps;
    this.root = path.resolve(deps.vaultRoot);
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.log = deps.log ?? (() => undefined);
  }

  /** Begin watching. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.disposed || this.watcher !== undefined) return;
    const ignored = this.makeIgnored();
    const factory = this.deps.watchFactory ?? defaultWatchFactory;
    const watcher = factory(this.root, ignored);
    watcher.on('add', (p) => this.onFileEvent(p));
    watcher.on('change', (p) => this.onFileEvent(p));
    watcher.on('error', (err) =>
      this.log('warn', `watcher error: ${err instanceof Error ? err.message : String(err)}`),
    );
    watcher.on('ready', () => {
      this.log('info', `watching vault ${this.root}`);
      this.deps.onReady?.();
    });
    this.watcher = watcher;
  }

  /** Stop watching + cancel pending debounced ingests. Idempotent. */
  async stop(): Promise<void> {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const w = this.watcher;
    this.watcher = undefined;
    if (w !== undefined) await w.close().catch(() => {});
  }

  private makeIgnored(): (p: string, stats?: { isFile(): boolean }) => boolean {
    const exclude = this.deps.exclude;
    const root = this.root;
    return (p: string, stats?: { isFile(): boolean }): boolean => {
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (rel.length === 0) return false; // the root itself
      // Skip dotfolders/dotfiles (`.obsidian`, `.git`, `.trash`) + tmp writes.
      if (rel.split('/').some((seg) => seg.startsWith('.'))) return true;
      if (p.endsWith('.tmp')) return true;
      // Match excludes against both the path AND a dir-style `rel/` form so an
      // excluded DIRECTORY (e.g. `Archive/`) is pruned from traversal, not just
      // its files — parity with the connector walk (audit m4).
      if (exclude.some((frag) => rel.includes(frag) || `${rel}/`.includes(frag))) return true;
      // Ignore non-markdown FILES; let directories through to keep traversing.
      if (stats?.isFile() === true && !p.toLowerCase().endsWith('.md')) return true;
      return false;
    };
  }

  private onFileEvent(absPath: string): void {
    if (this.disposed) return;
    if (!absPath.toLowerCase().endsWith('.md')) return;
    const rel = path.relative(this.root, absPath).split(path.sep).join('/');
    const existing = this.timers.get(rel);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(rel);
      void this.ingestFile(rel);
    }, this.debounceMs);
    // Don't keep the event loop alive solely for a pending debounce.
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(rel, timer);
  }

  private async ingestFile(relPath: string): Promise<void> {
    if (this.disposed) return;
    let candidates;
    try {
      candidates = await this.deps.connector.fetchTasksInFile(relPath);
    } catch (err) {
      this.log(
        'warn',
        `failed to parse ${relPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (this.disposed || candidates.length === 0) return;
    const ingestDeps: ObsidianIngestDeps = {
      taskStore: this.deps.taskStore,
      projectStore: this.deps.projectStore,
      externalLinkStore: this.deps.externalLinkStore,
      ...(this.deps.resolveProjectPath !== undefined
        ? { resolveProjectPath: this.deps.resolveProjectPath }
        : {}),
    };
    const result = ingestObsidianCandidates(candidates, ingestDeps);
    if (result.created.length > 0) {
      this.log('info', `${relPath}: created ${result.created.length} task(s)`);
    }
    this.deps.onIngest?.(relPath, result);
  }
}

const defaultWatchFactory: WatchFactory = (root, ignored) =>
  chokidar.watch(root, {
    ignored,
    ignoreInitial: true,
    persistent: true,
    atomic: true,
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    depth: 12,
  }) as unknown as FSWatcherLike;
