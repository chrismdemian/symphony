import path from 'node:path';

/**
 * Per-project chained-promise mutex. Git's lockfiles (packed-refs.lock,
 * worktree admin dirs) do not tolerate parallel mutations on the same
 * repo. Different projects run concurrently; same-project ops serialize.
 *
 * Multica parity: `server/internal/daemon/repocache/cache.go:42-48`.
 */
export class ProjectLockRegistry {
  private readonly tails = new Map<string, Promise<unknown>>();

  async withLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(projectPath);
    const prev = this.tails.get(key) ?? Promise.resolve();

    const run = prev.then(
      () => fn(),
      () => fn(),
    );
    this.tails.set(key, run);

    try {
      return await run;
    } finally {
      if (this.tails.get(key) === run) {
        this.tails.delete(key);
      }
    }
  }

  size(): number {
    return this.tails.size;
  }
}

export const projectLocks = new ProjectLockRegistry();
