export { excludeFromGit } from './exclude.js';
export { ProjectLockRegistry, projectLocks } from './locks.js';
export {
  WorktreeManager,
  addWorktreeWithCollisionRetry,
  inferProjectPath,
  isBranchCollisionError,
  slugify,
  type WorktreeManagerEvents,
} from './manager.js';
export {
  buildPathspecs,
  getPreserveCandidateFiles,
  isExcludedPath,
  matchesPreservePattern,
  preserveFilesToWorktree,
  resolvePreservePatterns,
  type PreserveSource,
  type ResolvedPreservePatterns,
} from './preserve.js';
export { ensureProjectPrepared, type ProjectPrepResult } from './project-prep.js';
export {
  assertWorktreeRemovable,
  looksLikeManagedWorktree,
  parseWorktreePorcelain,
  pathResolvesEqual,
  WorktreeSafetyError,
} from './safety.js';
export { readSymphonyConfig } from './symphony-config.js';
export {
  DEFAULT_EXCLUDE_SEGMENTS,
  DEFAULT_GIT_EXCLUDE_PATTERNS,
  DEFAULT_PRESERVE_PATTERNS,
  type CreateWorktreeOptions,
  type PreserveResult,
  type RemoveWorktreeOptions,
  type SymphonyConfig,
  type WorktreeInfo,
  type WorktreeManagerConfig,
  type WorktreeStatus,
} from './types.js';
export { parseWorktreeIncludeContent, readWorktreeInclude } from './worktree-include.js';
