import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  ObsidianVaultWatcher,
  type FSWatcherLike,
  type WatchFactory,
} from '../../src/integrations/obsidian-watcher.js';
import { MemoryExternalLinkStore } from '../../src/state/external-link-store.js';
import type { ObsidianConnectorHandle, ObsidianTaskCandidate } from '../../src/integrations/obsidian.js';
import type { ProjectStore } from '../../src/projects/types.js';
import type { TaskStore } from '../../src/state/types.js';

/** A controllable fake watcher: capture listeners, fire events on demand. */
function fakeWatcher(): {
  factory: WatchFactory;
  ignored?: (p: string, stats?: { isFile(): boolean }) => boolean;
  emit(event: 'add' | 'change', filePath: string): void;
  closed: boolean;
} {
  const listeners: Record<string, ((arg: string) => void)[]> = { add: [], change: [] };
  const state = {
    factory: (() => undefined) as unknown as WatchFactory,
    ignored: undefined as ((p: string, stats?: { isFile(): boolean }) => boolean) | undefined,
    emit(event: 'add' | 'change', filePath: string) {
      for (const l of listeners[event] ?? []) l(filePath);
    },
    closed: false,
  };
  const watcher: FSWatcherLike = {
    on(event: string, listener: (arg: never) => void) {
      if (event === 'add' || event === 'change') {
        (listeners[event] ??= []).push(listener as (arg: string) => void);
      }
      return this;
    },
    close: async () => {
      state.closed = true;
    },
  };
  state.factory = ((root, ignored) => {
    state.ignored = ignored;
    void root;
    return watcher;
  }) as WatchFactory;
  return state;
}

/** A frontmatter-less single candidate built from text → routed to `proj-1`. */
function candidate(externalId: string, title: string): ObsidianTaskCandidate {
  return {
    externalId,
    url: `obsidian://open?file=${title}`,
    title,
    status: 'pending',
    priority: 0,
    projectValue: null,
  };
}

interface CreatedTask {
  projectId: string;
  description: string;
  priority?: number;
}

function makeDeps(fileTasks: Record<string, ObsidianTaskCandidate[]>) {
  const created: CreatedTask[] = [];
  let seq = 0;
  const connector: ObsidianConnectorHandle = {
    fetchOpenTasks: async () => [],
    fetchTasksInFile: async (rel) => fileTasks[rel] ?? [],
    writeBackStatus: async () => ({ written: false }),
    checkVault: async () => ({ ok: true }),
  };
  const projectStore = {
    get: (nameOrId: string) =>
      nameOrId === 'proj-1' ? ({ id: 'proj-1', path: '/p' } as never) : undefined,
    list: () => [{ id: 'proj-1', path: '/p' }] as never,
  } as unknown as ProjectStore;
  const taskStore = {
    create: (input: CreatedTask) => {
      created.push(input);
      seq += 1;
      return { id: `t-${seq}` } as never;
    },
  } as unknown as TaskStore;
  const externalLinkStore = new MemoryExternalLinkStore();
  return {
    created,
    connector,
    projectStore,
    taskStore,
    externalLinkStore,
    resolveProjectPath: () => '/p', // active-project fallback resolves to proj-1
  };
}

describe('ObsidianVaultWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ingests a new task after the debounce window on a change event', async () => {
    const deps = makeDeps({ 'notes.md': [candidate('notes.md#h:aaa', 'New task')] });
    const fw = fakeWatcher();
    const watcher = new ObsidianVaultWatcher({
      ...deps,
      vaultRoot: '/vault',
      exclude: [],
      debounceMs: 300,
      watchFactory: fw.factory,
    });
    watcher.start();
    fw.emit('change', path.join('/vault', 'notes.md'));
    // Before the debounce elapses, nothing is ingested.
    expect(deps.created).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(deps.created).toHaveLength(1);
    expect(deps.created[0]?.description).toBe('New task');
    await watcher.stop();
  });

  it('coalesces rapid events for the same file into one ingest', async () => {
    const deps = makeDeps({ 'notes.md': [candidate('notes.md#h:aaa', 'One')] });
    const fw = fakeWatcher();
    const watcher = new ObsidianVaultWatcher({
      ...deps,
      vaultRoot: '/vault',
      exclude: [],
      debounceMs: 300,
      watchFactory: fw.factory,
    });
    watcher.start();
    const abs = path.join('/vault', 'notes.md');
    fw.emit('change', abs);
    await vi.advanceTimersByTimeAsync(100);
    fw.emit('change', abs); // resets the debounce
    await vi.advanceTimersByTimeAsync(100);
    fw.emit('change', abs);
    await vi.advanceTimersByTimeAsync(300);
    expect(deps.created).toHaveLength(1);
    await watcher.stop();
  });

  it('is loop-safe: a re-fire on an already-linked task creates nothing', async () => {
    const deps = makeDeps({ 'notes.md': [candidate('notes.md#h:aaa', 'Linked')] });
    const fw = fakeWatcher();
    const watcher = new ObsidianVaultWatcher({
      ...deps,
      vaultRoot: '/vault',
      exclude: [],
      debounceMs: 50,
      watchFactory: fw.factory,
    });
    watcher.start();
    const abs = path.join('/vault', 'notes.md');
    fw.emit('change', abs);
    await vi.advanceTimersByTimeAsync(50);
    expect(deps.created).toHaveLength(1);
    // Second change (e.g. the writeback flipping the checkbox) → already linked.
    fw.emit('change', abs);
    await vi.advanceTimersByTimeAsync(50);
    expect(deps.created).toHaveLength(1);
    await watcher.stop();
  });

  it('ignores non-markdown files', async () => {
    const deps = makeDeps({});
    const fw = fakeWatcher();
    const watcher = new ObsidianVaultWatcher({
      ...deps,
      vaultRoot: '/vault',
      exclude: [],
      debounceMs: 50,
      watchFactory: fw.factory,
    });
    watcher.start();
    fw.emit('change', path.join('/vault', 'image.png'));
    await vi.advanceTimersByTimeAsync(50);
    expect(deps.created).toHaveLength(0);
    await watcher.stop();
  });

  it('the ignored predicate filters dotfolders, excludes, tmp files, and non-md', () => {
    const deps = makeDeps({});
    const fw = fakeWatcher();
    const watcher = new ObsidianVaultWatcher({
      ...deps,
      vaultRoot: '/vault',
      exclude: ['Archive/'],
      watchFactory: fw.factory,
    });
    watcher.start();
    const ig = fw.ignored!;
    const file = { isFile: () => true };
    const dir = { isFile: () => false };
    expect(ig(path.join('/vault', '.obsidian', 'app.json'), file)).toBe(true);
    expect(ig(path.join('/vault', 'Archive', 'old.md'), file)).toBe(true);
    // The excluded DIRECTORY itself is pruned from traversal too (audit m4).
    expect(ig(path.join('/vault', 'Archive'), dir)).toBe(true);
    expect(ig(path.join('/vault', 'notes.md.symphony-1.tmp'), file)).toBe(true);
    expect(ig(path.join('/vault', 'pic.png'), file)).toBe(true);
    expect(ig(path.join('/vault', 'notes.md'), file)).toBe(false);
  });

  it('stop() cancels a pending debounced ingest', async () => {
    const deps = makeDeps({ 'notes.md': [candidate('notes.md#h:aaa', 'Pending')] });
    const fw = fakeWatcher();
    const watcher = new ObsidianVaultWatcher({
      ...deps,
      vaultRoot: '/vault',
      exclude: [],
      debounceMs: 300,
      watchFactory: fw.factory,
    });
    watcher.start();
    fw.emit('change', path.join('/vault', 'notes.md'));
    await watcher.stop();
    expect(fw.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(deps.created).toHaveLength(0);
  });
});
