import path from 'node:path';
import type {
  ProjectRecord,
  ProjectRegistryListFilter,
  ProjectSnapshot,
  ProjectStore,
} from './types.js';

export class DuplicateProjectError extends Error {
  readonly projectName: string;
  constructor(name: string) {
    super(`ProjectRegistry: duplicate project name '${name}'`);
    this.name = 'DuplicateProjectError';
    this.projectName = name;
  }
}

export interface ProjectRegistryOptions {
  readonly now?: () => number;
}

/**
 * In-memory authoritative state for projects.
 *
 * Phase 2B will replace this with a SQLite-backed implementation; every
 * consumer goes through `ProjectStore`, so that swap is a one-line DI
 * change in `server.ts`.
 */
export class ProjectRegistry implements ProjectStore {
  private readonly byId = new Map<string, ProjectRecord>();
  private readonly byName = new Map<string, string>();
  private readonly now: () => number;

  constructor(opts: ProjectRegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  list(filter: ProjectRegistryListFilter = {}): ProjectRecord[] {
    const all = Array.from(this.byId.values());
    if (!filter.nameContains || filter.nameContains.trim().length === 0) {
      return all;
    }
    const needle = filter.nameContains.trim().toLowerCase();
    return all.filter((r) => r.name.toLowerCase().includes(needle));
  }

  get(nameOrId: string): ProjectRecord | undefined {
    if (nameOrId.length === 0) return undefined;
    const direct = this.byId.get(nameOrId);
    if (direct) return direct;
    const mapped = this.byName.get(nameOrId);
    return mapped ? this.byId.get(mapped) : undefined;
  }

  register(record: ProjectRecord): ProjectRecord {
    if (!record.name || !record.name.trim()) {
      throw new Error('ProjectRegistry.register: name is required');
    }
    if (!record.path || !record.path.trim()) {
      throw new Error('ProjectRegistry.register: path is required');
    }
    // Reject direct duplicates AND cross-namespace collisions (id-as-name,
    // name-as-id). Without the cross check, `get(x)` can silently return a
    // different project when one project's id equals another's name —
    // see Phase 2A.3 audit M1.
    if (
      this.byId.has(record.id) ||
      this.byName.has(record.name) ||
      this.byId.has(record.name) ||
      this.byName.has(record.id)
    ) {
      throw new DuplicateProjectError(record.name);
    }
    const resolved: ProjectRecord = {
      ...record,
      path: path.resolve(record.path),
      createdAt: record.createdAt || new Date(this.now()).toISOString(),
    };
    this.byId.set(resolved.id, resolved);
    this.byName.set(resolved.name, resolved.id);
    return resolved;
  }

  snapshot(nameOrId: string): ProjectSnapshot | undefined {
    const r = this.get(nameOrId);
    return r ? toProjectSnapshot(r) : undefined;
  }

  snapshots(filter: ProjectRegistryListFilter = {}): ProjectSnapshot[] {
    return this.list(filter).map(toProjectSnapshot);
  }

  size(): number {
    return this.byId.size;
  }
}

export function toProjectSnapshot(r: ProjectRecord): ProjectSnapshot {
  const base = {
    id: r.id,
    name: r.name,
    path: r.path,
    createdAt: r.createdAt,
  } as const;
  return {
    ...base,
    ...(r.gitRemote !== undefined ? { gitRemote: r.gitRemote } : {}),
    ...(r.gitBranch !== undefined ? { gitBranch: r.gitBranch } : {}),
    ...(r.baseRef !== undefined ? { baseRef: r.baseRef } : {}),
    ...(r.defaultModel !== undefined ? { defaultModel: r.defaultModel } : {}),
  };
}

/**
 * Build a `ProjectRegistry` from the legacy `OrchestratorServerOptions.projects`
 * name→path map. `id === name` in this mode; Phase 2B will assign a UUID on
 * DB insert and keep `name` as a unique secondary key.
 */
export function projectRegistryFromMap(
  projects: Readonly<Record<string, string>>,
  opts: ProjectRegistryOptions = {},
): ProjectRegistry {
  const registry = new ProjectRegistry(opts);
  for (const [name, pathStr] of Object.entries(projects)) {
    if (!pathStr || typeof pathStr !== 'string') continue;
    registry.register({
      id: name,
      name,
      path: pathStr,
      createdAt: '',
    });
  }
  return registry;
}
