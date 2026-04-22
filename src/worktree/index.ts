export { excludeFromGit } from './exclude.js';
export { ProjectLockRegistry, projectLocks } from './locks.js';
export {
  WorktreeManager,
  addWorktreeWithCollisionRetry,
  inferProjectPath,
  isBranchCollisionError,
  isPoolEnabled,
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
  type WorktreeSafetyCode,
} from './safety.js';
export { readSymphonyConfig } from './symphony-config.js';
export {
  DEFAULT_EXCLUDE_SEGMENTS,
  DEFAULT_GIT_EXCLUDE_PATTERNS,
  DEFAULT_PRESERVE_PATTERNS,
  type ClaimReserveOptions,
  type CreateWorktreeOptions,
  type PreserveResult,
  type RemoveWorktreeOptions,
  type ReserveInfo,
  type SymphonyConfig,
  type WorktreeInfo,
  type WorktreeManagerConfig,
  type WorktreePoolEvents,
  type WorktreePoolHandle,
  type WorktreePoolOptions,
  type WorktreeStatus,
} from './types.js';
export {
  WorktreePool,
  canonicalizeBaseRef,
  parseReserveDirName,
  reserveKey,
  stripOriginPrefix,
} from './pool.js';
export { parseWorktreeIncludeContent, readWorktreeInclude } from './worktree-include.js';
