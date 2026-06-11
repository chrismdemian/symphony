import path from 'node:path';
import { z } from 'zod';
import type { ProjectStore } from '../../projects/types.js';
import { currentBranch, push as gitPush, PushRejectedError, GitOpsError } from '../git-ops.js';
import { resolveDefaultMergeTo } from '../auto-merge-helper.js';
import {
  generatePrContent,
  resolvePrBaseRef,
  type GeneratedPrContent,
} from '../pr-generation.js';

/** PR content can also be fully user/Maestro-supplied — distinct from the generator's sources. */
type PrContentSource = GeneratedPrContent['source'] | 'override';
import { defaultGhRunner, GhCliError, type GhRunner } from '../gh-cli.js';
import type { OneShotRunner } from '../one-shot.js';
import type { ToolRegistration } from '../registry.js';
import type { DispatchContext } from '../types.js';
import type { WorkerRecord, WorkerRegistry } from '../worker-registry.js';

/**
 * Phase 3O.2 — `open_pr`. Maestro-invoked, on-demand: generate a PR title +
 * description from the worker branch's diff/commits and open the PR via the
 * GitHub CLI (`gh`). Returns the PR URL for Maestro to relay; no automatic
 * gate, no chat-event broker (the tool result IS the surface).
 *
 * Capability: `external-visible` → Tier ≥2 (opening a PR is user-visible).
 * NOT `irreversible` — a PR can be closed. The capability evaluator enforces
 * the Tier-2 floor at dispatch; no manual tier check here.
 *
 * Flow: resolve worker → gh/remote preflight → resolve base → push the
 * branch (idempotent; ensures the remote tip matches local HEAD) →
 * generate content (unless both title+body supplied) → `gh pr create`.
 */

export type PushFn = typeof gitPush;

export interface OpenPrDeps {
  readonly registry: WorkerRegistry;
  readonly projectStore: ProjectStore;
  /** Generator's one-shot Claude runner. Defaults inside `generatePrContent`. */
  readonly oneShotRunner?: OneShotRunner;
  /** Test seam — defaults to the real `gh` runner. */
  readonly ghRunner?: GhRunner;
  /** Test seam — defaults to `git-ops.push`. */
  readonly push?: PushFn;
  /** Test seam — defaults to `pr-generation.generatePrContent`. */
  readonly generate?: typeof generatePrContent;
}

const shape = {
  worker_id: z.string().min(1).describe('Worker id whose branch should become a PR.'),
  base: z
    .string()
    .min(1)
    .optional()
    .describe("Base branch to open the PR against. Defaults to the repo's default branch."),
  draft: z.boolean().optional().describe('Open the PR as a draft. Default false.'),
  title: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Override the generated PR title.'),
  body: z
    .string()
    .max(60_000)
    .optional()
    .describe('Override the generated PR description (markdown).'),
  model: z
    .string()
    .optional()
    .describe('Model for the title/description generator. Defaults to project default.'),
};

export function makeOpenPrTool(deps: OpenPrDeps): ToolRegistration<typeof shape> {
  const ghRunner = deps.ghRunner ?? defaultGhRunner;
  const push = deps.push ?? gitPush;
  const generate = deps.generate ?? generatePrContent;

  return {
    name: 'open_pr',
    description:
      'Generate a PR title + description from a worker branch and open the pull request on GitHub via `gh`. Pushes the branch first. Use on an explicit "open a PR for X" request. Requires `gh` installed + authenticated and a GitHub remote.',
    scope: 'act',
    capabilities: ['external-visible'],
    inputSchema: shape,
    handler: async (
      { worker_id, base, draft, title, body, model },
      ctx: DispatchContext,
    ) => {
      const record = deps.registry.get(worker_id);
      if (!record) {
        return err(`Unknown worker '${worker_id}'.`);
      }

      const branch = await currentBranch(record.worktreePath, ctx.signal);
      if (branch === null) {
        return err(
          `Worker '${worker_id}' worktree is in detached-HEAD state; cannot open a PR for a branch.`,
        );
      }

      const repoPath = path.resolve(resolveProjectPath(deps.projectStore, record));
      if (path.resolve(record.worktreePath) === repoPath) {
        return err(
          'open_pr requires a worker worktree distinct from the project root. This worker appears to be running in the main repo itself.',
        );
      }

      // gh + remote preflight — graceful, actionable errors (not exceptions).
      const availability = await ghRunner.checkAvailable(record.worktreePath, ctx.signal);
      if (!availability.available) {
        return err(availability.detail ?? 'GitHub CLI (`gh`) is unavailable.', {
          code: availability.reason ?? 'gh-unavailable',
        });
      }
      const hasRemote = await ghRunner.hasGitHubRemote(record.worktreePath, 'origin', ctx.signal);
      if (!hasRemote) {
        return err(
          "This project has no GitHub `origin` remote; `open_pr` only works against GitHub repositories.",
          { code: 'no-github-remote' },
        );
      }

      const baseBranch = base ?? (await resolveDefaultMergeTo(record.worktreePath, ctx.signal));
      if (branch === baseBranch) {
        return err(
          `The worker branch ('${branch}') is the same as the base branch ('${baseBranch}') — nothing to open a PR from.`,
          { code: 'branch-equals-base' },
        );
      }

      // Push the branch so the remote tip matches local HEAD (idempotent —
      // a no-op when already up to date). A PR opens against the remote ref,
      // so unpushed commits would otherwise be missing from it.
      try {
        await push({
          worktreePath: record.worktreePath,
          branch,
          setUpstream: true,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
      } catch (e) {
        if (e instanceof PushRejectedError) {
          return err(
            `Could not push '${branch}' before opening the PR (remote rejected): ${firstLine(e.stderr) || e.message}`,
            { code: 'push-rejected' },
          );
        }
        if (e instanceof GitOpsError) {
          return err(`Could not push '${branch}' before opening the PR: ${e.message}`, {
            code: 'push-failed',
          });
        }
        throw e; // AbortError or unexpected — let the dispatch shim handle it
      }

      // Generate (or accept overridden) content.
      let content: { title: string; description: string; source: PrContentSource };
      if (title !== undefined && body !== undefined) {
        content = { title, description: body, source: 'override' };
      } else {
        const baseRef = await resolvePrBaseRef(
          record.worktreePath,
          baseBranch,
          'origin',
          ctx.signal,
        );
        const generated = await generate(
          {
            worktreePath: record.worktreePath,
            baseRef,
            ...(model !== undefined ? { model } : {}),
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          },
          { ...(deps.oneShotRunner !== undefined ? { oneShotRunner: deps.oneShotRunner } : {}) },
        );
        content = {
          title: title ?? generated.title,
          description: body ?? generated.description,
          source: generated.source,
        };
      }

      // Create the PR.
      let result;
      try {
        result = await ghRunner.createPr({
          cwd: record.worktreePath,
          base: baseBranch,
          head: branch,
          title: content.title,
          body: content.description,
          draft: draft === true,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
      } catch (e) {
        if (e instanceof GhCliError) {
          return err(`open_pr: ${e.message}`, { code: 'gh-create-failed' });
        }
        throw e;
      }

      const verb = result.alreadyExisted ? 'A PR already exists' : 'Opened PR';
      const text = [
        `${verb} for '${branch}' → ${baseBranch}${draft === true ? ' (draft)' : ''}`,
        `  ${result.url}`,
        `  title: ${content.title}`,
        `  description from: ${content.source}`,
      ].join('\n');

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          worker_id,
          url: result.url,
          already_existed: result.alreadyExisted,
          base: baseBranch,
          head: branch,
          draft: draft === true,
          title: content.title,
          description_source: content.source,
        },
      };
    },
  };
}

function err(message: string, structured?: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError: true;
} {
  return {
    content: [{ type: 'text', text: message }],
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    isError: true,
  };
}

function firstLine(s: string): string {
  return s.split(/\r?\n/)[0]?.trim() ?? '';
}

function resolveProjectPath(store: ProjectStore, record: WorkerRecord): string {
  const resolved = path.resolve(record.projectPath);
  for (const candidate of store.list()) {
    if (path.resolve(candidate.path) === resolved) return candidate.path;
  }
  return resolved;
}
