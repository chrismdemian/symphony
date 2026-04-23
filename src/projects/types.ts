/**
 * Project records describe codebases Symphony can orchestrate against.
 *
 * Phase 2A.3 ships an in-memory implementation seeded from
 * `OrchestratorServerOptions.projects` (a name→path map). Phase 2B swaps
 * the in-memory store for a SQLite-backed implementation behind the same
 * `ProjectStore` interface — zero tool-surface churn.
 *
 * Identity model: `id` equals `name` for in-memory mode. Phase 2B moves
 * `id` to a stable UUID generated on insert with `name` kept as a unique
 * secondary key. Anything reading from the store must treat `id` as
 * opaque — do NOT parse it as a path.
 */
export interface ProjectRecord {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly gitRemote?: string;
  readonly gitBranch?: string;
  readonly baseRef?: string;
  readonly defaultModel?: string;
  readonly createdAt: string;
}

export interface ProjectSnapshot {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly gitRemote?: string;
  readonly gitBranch?: string;
  readonly baseRef?: string;
  readonly defaultModel?: string;
  readonly createdAt: string;
}

export interface ProjectRegistryListFilter {
  readonly nameContains?: string;
}

export interface ProjectStore {
  list(filter?: ProjectRegistryListFilter): ProjectRecord[];
  /** Resolve by name OR id. Returns undefined when not found. */
  get(nameOrId: string): ProjectRecord | undefined;
  register(record: ProjectRecord): ProjectRecord;
  snapshot(nameOrId: string): ProjectSnapshot | undefined;
  snapshots(filter?: ProjectRegistryListFilter): ProjectSnapshot[];
  size(): number;
}
