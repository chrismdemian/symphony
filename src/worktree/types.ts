export interface WorktreeInfo {
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly projectPath: string;
  readonly createdAt: string;
}

export interface CreateWorktreeOptions {
  readonly projectPath: string;
  readonly workerId: string;
  readonly baseRef?: string;
  readonly shortDescription?: string;
  readonly skipProjectPrep?: boolean;
  readonly skipPreserve?: boolean;
  /**
   * Cooperative-cancellation signal. Checked at entry, after worktree creation,
   * and passed to the underlying git spawn. If aborted mid-flight after the
   * worktree has materialized on disk, the manager will best-effort remove it
   * before rejecting. Added in Phase 2A.3 (audit M2).
   */
  readonly signal?: AbortSignal;
}

export interface RemoveWorktreeOptions {
  readonly deleteBranch?: boolean;
}

export interface PreserveResult {
  readonly copied: readonly string[];
  readonly skipped: readonly string[];
}

export interface WorktreeStatus {
  readonly hasChanges: boolean;
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
}

export interface SymphonyConfig {
  readonly preservePatterns?: readonly string[];
  readonly lifecycleScripts?: {
    readonly setup?: string;
    readonly teardown?: string;
  };
  readonly worktreePool?: {
    readonly enabled?: boolean;
    readonly size?: number;
  };
  /**
   * Per-project worker concurrency cap (Phase 3H.2). Wins over the global
   * `~/.symphony/config.json` `maxConcurrentWorkers` for spawns into this
   * project. Out-of-range values are ignored — the lifecycle clamps to the
   * global default. Validated at the cap-getter, not here, so a typo in a
   * project file never crashes worktree creation.
   */
  readonly maxConcurrentWorkers?: number;
}

export interface WorktreeManagerConfig {
  readonly branchPrefix?: string;
  readonly runProjectPrep?: boolean;
  readonly excludePatterns?: readonly string[];
  /**
   * Optional pool. When present AND the project's `.symphony.json` sets
   * `worktreePool.enabled === true`, `create()` first tries to claim a
   * pre-warmed reserve before falling back to synchronous creation.
   * Leaving this undefined disables pooling entirely regardless of config.
   */
  readonly pool?: WorktreePoolHandle;
}

/**
 * Opaque handle the manager calls into. Keeps `WorktreeManager` free of a
 * direct dependency on `WorktreePool` (avoids an import cycle and lets
 * tests substitute a stub).
 */
export interface WorktreePoolHandle {
  claimReserve(opts: ClaimReserveOptions): Promise<WorktreeInfo | null>;
  ensureReserve(projectPath: string, baseRef?: string): Promise<void>;
}

export interface ClaimReserveOptions {
  readonly projectPath: string;
  readonly workerId: string;
  readonly shortDescription?: string;
  readonly baseRef?: string;
  readonly branchPrefix: string;
  readonly excludePatterns: readonly string[];
  readonly skipPreserve?: boolean;
  readonly skipProjectPrep?: boolean;
  readonly runProjectPrep?: boolean;
  readonly onPreserveResult?: (info: {
    readonly worktreePath: string;
    readonly copied: readonly string[];
    readonly skipped: readonly string[];
  }) => void;
  readonly onProjectPrep?: (info: {
    readonly worktreePath: string;
    readonly detected: string | null;
    readonly spawned: boolean;
  }) => void;
}

export interface ReserveInfo {
  readonly id: string;
  readonly path: string;
  readonly branch: string;
  readonly projectPath: string;
  readonly baseRef: string;
  readonly resolvedRef: string;
  readonly commitHash: string;
  readonly createdAt: string;
}

export interface WorktreePoolOptions {
  readonly locks?: import('./locks.js').ProjectLockRegistry;
  readonly maxReserveAgeMs?: number;
  readonly freshnessPollIntervalMs?: number;
  readonly runPoll?: boolean;
  readonly now?: () => number;
  readonly events?: WorktreePoolEvents;
}

export interface WorktreePoolEvents {
  readonly onReserveCreated?: (reserve: ReserveInfo) => void;
  readonly onReserveClaimed?: (info: { reserve: ReserveInfo; worktree: WorktreeInfo }) => void;
  readonly onReserveStale?: (info: { reserve: ReserveInfo; currentHash: string }) => void;
  readonly onPollTick?: (info: { reserves: number }) => void;
  readonly onOrphanCleanup?: (info: { path: string; ok: boolean }) => void;
}

export const DEFAULT_PRESERVE_PATTERNS: readonly string[] = [
  '.env',
  '.env.local',
  '.env.keys',
  '.env.*.local',
  '.envrc',
  'docker-compose.override.yml',
];

export const DEFAULT_EXCLUDE_SEGMENTS: readonly string[] = [
  'node_modules',
  '.git',
  'vendor',
  '.cache',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
];

export const DEFAULT_GIT_EXCLUDE_PATTERNS: readonly string[] = [
  '.agent_context',
  'CLAUDE.md',
  'AGENTS.md',
  '.symphony/',
  '.claude/',
];
