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
  private readonly byPath = new Map<string, string>();
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
    // Phase 2B.1 audit M2: path-uniqueness — matches the SQL
    // `projects.path UNIQUE` constraint enforced by the SQLite store.
    // Without this, `--in-memory` mode accepts two projects at the same
    // path; SQLite mode rejects. Aligns both behaviors.
    const resolvedPath = path.resolve(record.path);
    if (this.byPath.has(resolvedPath)) {
      throw new DuplicateProjectError(record.name);
    }
    const resolved: ProjectRecord = {
      ...record,
      path: resolvedPath,
      createdAt: record.createdAt || new Date(this.now()).toISOString(),
    };
    this.byId.set(resolved.id, resolved);
    this.byName.set(resolved.name, resolved.id);
    this.byPath.set(resolvedPath, resolved.id);
    return resolved;
  }

  delete(idOrName: string): boolean {
    const record = this.get(idOrName);
    if (!record) return false;
    this.byId.delete(record.id);
    this.byName.delete(record.name);
    this.byPath.delete(record.path);
    return true;
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
    ...(r.lintCommand !== undefined ? { lintCommand: r.lintCommand } : {}),
    ...(r.testCommand !== undefined ? { testCommand: r.testCommand } : {}),
    ...(r.buildCommand !== undefined ? { buildCommand: r.buildCommand } : {}),
    ...(r.verifyCommand !== undefined ? { verifyCommand: r.verifyCommand } : {}),
    ...(r.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: r.verifyTimeoutMs } : {}),
    ...(r.finalizeDefault !== undefined ? { finalizeDefault: r.finalizeDefault } : {}),
  };
}

/**
 * Build a `ProjectRegistry` from the legacy `OrchestratorServerOptions.projects`
 * name→path map. `id === name` in this mode; Phase 2B will assign a UUID on
 * DB insert and keep `name` as a unique secondary key.
 *
 * Optional `configs` overlay per-project fields (`lintCommand` etc.) — the
 * name→path map stays load-bearing for existing callers.
 */
export function projectRegistryFromMap(
  projects: Readonly<Record<string, string>>,
  opts: ProjectRegistryOptions & {
    configs?: Readonly<Record<string, Partial<ProjectRecord>>>;
  } = {},
): ProjectRegistry {
  const registry = new ProjectRegistry(opts);
  const configs = opts.configs ?? {};
  for (const [name, pathStr] of Object.entries(projects)) {
    if (!pathStr || typeof pathStr !== 'string') continue;
    const extra = configs[name] ?? {};
    registry.register({
      id: name,
      name,
      path: pathStr,
      createdAt: '',
      ...extra,
    });
  }
  return registry;
}
