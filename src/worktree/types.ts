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
}

export interface WorktreeManagerConfig {
  readonly branchPrefix?: string;
  readonly runProjectPrep?: boolean;
  readonly excludePatterns?: readonly string[];
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
