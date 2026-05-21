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
  /** Finalize pipeline commands — see Phase 2A.4b. */
  readonly lintCommand?: string;
  readonly testCommand?: string;
  readonly buildCommand?: string;
  readonly verifyCommand?: string;
  /** Default 60_000 ms at the consumer — kill subprocess on timeout. */
  readonly verifyTimeoutMs?: number;
  /**
   * Phase 4G.2 — preview server for UI verification. `verify_ui` boots
   * this command in the worker's worktree, waits for ready, captures
   * screenshots, then tears it down. Absence ⇒ no UI verification leg.
   */
  readonly previewCommand?: string;
  /**
   * Phase 4G.2 — boot-wait cap for `previewCommand`. Default 30_000 ms
   * at the consumer. Distinct from `verifyTimeoutMs` (verify is a
   * run-to-completion smoke; preview is a long-running server we wait
   * for then keep alive while screenshots run).
   */
  readonly previewTimeoutMs?: number;
  /** Hint for prompt composition; not enforced in 2A.4b. */
  readonly finalizeDefault?: 'push' | 'merge';
  /**
   * Phase 5A — multi-project config fields. Persisted via migration 0009;
   * source-of-truth is `<project>/.symphony.json` `project` section (Zod
   * schema in `src/worktree/symphony-config.ts`). The Zod schema enforces
   * value-range validation; SQL columns are nullable + uncheck'd.
   *
   * NOTE: 5A persists these fields. Most consumers (per-project MCP
   * routing, Maestro warmth/tier/planMode) wire up in 5B–5F.
   */
  readonly worktreeDir?: string;
  readonly mcpConfig?: string;
  readonly maxConcurrentWorkers?: number;
  readonly qualityPipeline?: 'full' | 'simplified' | 'none';
  readonly planModeRequired?: boolean;
  readonly defaultAutonomyTier?: 1 | 2 | 3;
  readonly maestroWarmth?: number;
  readonly droidsDir?: string;
  readonly designInspiration?: string;
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
  readonly lintCommand?: string;
  readonly testCommand?: string;
  readonly buildCommand?: string;
  readonly verifyCommand?: string;
  readonly verifyTimeoutMs?: number;
  readonly previewCommand?: string;
  readonly previewTimeoutMs?: number;
  readonly finalizeDefault?: 'push' | 'merge';
  // Phase 5A
  readonly worktreeDir?: string;
  readonly mcpConfig?: string;
  readonly maxConcurrentWorkers?: number;
  readonly qualityPipeline?: 'full' | 'simplified' | 'none';
  readonly planModeRequired?: boolean;
  readonly defaultAutonomyTier?: 1 | 2 | 3;
  readonly maestroWarmth?: number;
  readonly droidsDir?: string;
  readonly designInspiration?: string;
}

/** Partial project record used by `OrchestratorServerOptions.projectConfigs`. */
export type ProjectConfigInput = Pick<
  ProjectRecord,
  | 'lintCommand'
  | 'testCommand'
  | 'buildCommand'
  | 'verifyCommand'
  | 'verifyTimeoutMs'
  | 'previewCommand'
  | 'previewTimeoutMs'
  | 'finalizeDefault'
  | 'defaultModel'
  | 'gitRemote'
  | 'gitBranch'
  | 'baseRef'
  // Phase 5A
  | 'worktreeDir'
  | 'mcpConfig'
  | 'maxConcurrentWorkers'
  | 'qualityPipeline'
  | 'planModeRequired'
  | 'defaultAutonomyTier'
  | 'maestroWarmth'
  | 'droidsDir'
  | 'designInspiration'
>;

export interface ProjectRegistryListFilter {
  readonly nameContains?: string;
}

export interface ProjectStore {
  list(filter?: ProjectRegistryListFilter): ProjectRecord[];
  /** Resolve by name OR id. Returns undefined when not found. */
  get(nameOrId: string): ProjectRecord | undefined;
  register(record: ProjectRecord): ProjectRecord;
  /**
   * Remove a project by id OR name. Returns true if a row was deleted.
   * Phase 2B.1 m6 (`default-N` orphan prune) is the only current caller —
   * callers MUST verify there are no task or worker references first; the
   * SQLite implementation enforces FK so a referenced row throws.
   */
  delete(idOrName: string): boolean;
  snapshot(nameOrId: string): ProjectSnapshot | undefined;
  snapshots(filter?: ProjectRegistryListFilter): ProjectSnapshot[];
  size(): number;
}
