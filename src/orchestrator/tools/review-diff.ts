import { z } from 'zod';
import {
  DEFAULT_DIFF_SIZE_CAP_BYTES,
  currentBranch,
  diffWorktree,
} from '../git-ops.js';
import type { ToolRegistration } from '../registry.js';
import type { WorkerRegistry } from '../worker-registry.js';

const shape = {
  worker_id: z
    .string()
    .min(1)
    .describe('Worker id whose worktree diff should be captured.'),
  base_ref: z
    .string()
    .optional()
    .describe('Git ref to diff against. Default HEAD (shows staged + unstaged changes in the worktree).'),
  cap_bytes: z
    .number()
    .int()
    .min(1_000)
    .max(500_000)
    .optional()
    .describe(`Truncate the diff body above this many bytes. Default ${DEFAULT_DIFF_SIZE_CAP_BYTES}. Files list is always complete.`),
};

export interface ReviewDiffDeps {
  readonly registry: WorkerRegistry;
}

export function makeReviewDiffTool(
  deps: ReviewDiffDeps,
): ToolRegistration<typeof shape> {
  return {
    name: 'review_diff',
    description:
      "Return the git diff of a worker's worktree against baseRef (default HEAD). Staged + unstaged + untracked are combined; diff body truncates at cap_bytes (default 50KB). Use instead of reading the worker's full output log.",
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: async ({ worker_id, base_ref, cap_bytes }, ctx) => {
      const record = deps.registry.get(worker_id);
      if (!record) {
        return {
          content: [{ type: 'text', text: `Unknown worker '${worker_id}'.` }],
          isError: true,
        };
      }
      try {
        const [result, branch] = await Promise.all([
          diffWorktree({
            worktreePath: record.worktreePath,
            ...(base_ref !== undefined ? { baseRef: base_ref } : {}),
            ...(cap_bytes !== undefined ? { capBytes: cap_bytes } : {}),
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          }),
          currentBranch(record.worktreePath, ctx.signal),
        ]);
        const header =
          `Worker ${worker_id} @ ${record.worktreePath}` +
          (branch !== null ? ` (branch ${branch})` : '') +
          `\nBase: ${result.baseRef} · ${result.files.length} file(s) changed · ${result.bytes} bytes${
            result.truncated ? ' (truncated)' : ''
          }\n\n`;
        return {
          content: [{ type: 'text', text: header + (result.diff || '(no diff)') }],
          structuredContent: {
            worker_id,
            worktree_path: record.worktreePath,
            branch,
            base_ref: result.baseRef,
            bytes: result.bytes,
            truncated: result.truncated,
            files: result.files as unknown as Record<string, unknown>[],
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `review_diff failed: ${msg}` }],
          isError: true,
        };
      }
    },
  };
}
