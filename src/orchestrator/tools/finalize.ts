import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { ProjectRecord, ProjectStore } from '../../projects/types.js';
import type { WorkerStatus } from '../../workers/types.js';
import { currentBranch } from '../git-ops.js';

const execFileAsync = promisify(execFile);

const TERMINAL_WORKER_STATUSES: readonly WorkerStatus[] = [
  'completed',
  'failed',
  'killed',
  'timeout',
  'crashed',
];
import {
  runFinalize,
  type FinalizeConfig,
  type FinalizeRunResult,
  type FinalizeStepOutcome,
} from '../finalize-runner.js';
import { runAudit, type AuditChangesDeps, type AuditResult } from './audit-changes.js';
import type { OneShotRunner } from '../one-shot.js';
import type { ToolRegistration } from '../registry.js';
import type { DispatchContext } from '../types.js';
import type { WorkerRegistry, WorkerRecord } from '../worker-registry.js';

/**
 * `finalize` — the atomic-verb completion protocol. See
 * maestro-prompt-design.md §7 and PLAN.md behavioral rule #1.
 *
 * Pipeline: audit → lint → test → build → verify → commit → push → merge?
 *
 * Capability flags:
 *   - `external-visible` declared statically (push is user-visible).
 *   - `irreversible` enforced at runtime for `merge_to` and `skip_audit`.
 *     Capability-flag evaluation is static today (dispatch.ts:52); the
 *     runtime check is a documented seam. A future refactor could teach
 *     `CapabilityEvaluator.evaluate` to accept runtime flags.
 */

const shape = {
  worker_id: z
    .string()
    .min(1)
    .describe('Worker id whose diff should be finalized.'),
  commit_message: z
    .string()
    .min(1)
    .max(10_000)
    .optional()
    .describe("Commit message. Defaults to '<role>: <feature_intent>'."),
  merge_to: z
    .string()
    .min(1)
    .optional()
    .describe("Branch to merge into after push (e.g. 'master'). Requires tier 3."),
  source_remote: z
    .string()
    .min(1)
    .optional()
    .describe("Git remote for push/merge. Default 'origin'."),
  skip_audit: z
    .boolean()
    .optional()
    .describe('Skip audit_changes step. Requires tier 3 — escape hatch only.'),
  allow_untracked: z
    .boolean()
    .optional()
    .describe(
      'Permit finalize when untracked files are present. Required to ship new files the auditor only saw by filename (they never see untracked content). Requires tier 3.',
    ),
  force_finalize_while_running: z
    .boolean()
    .optional()
    .describe(
      'Bypass the "worker must be in a terminal state" guard. Required to finalize a worker that is still spawning/running — races worker writes. Requires tier 3.',
    ),
  audit_model: z
    .string()
    .optional()
    .describe('Model for the inline audit step. Defaults to project defaultModel.'),
};

export interface FinalizeDeps {
  readonly registry: WorkerRegistry;
  readonly projectStore: ProjectStore;
  readonly oneShotRunner?: OneShotRunner;
  /** Test seam — override the step runner. */
  readonly finalizeRunner?: typeof runFinalize;
}

export function makeFinalizeTool(
  deps: FinalizeDeps,
): ToolRegistration<typeof shape> {
  const finalizeRunner = deps.finalizeRunner ?? runFinalize;
  return {
    name: 'finalize',
    description:
      "Atomic ship verb — runs audit → lint → test → build → verify → commit → push → optional merge. `merge_to`+`skip_audit` require tier 3. Stops at first failure and returns the structured log.",
    scope: 'act',
    capabilities: ['external-visible'],
    inputSchema: shape,
    handler: async (
      {
        worker_id,
        commit_message,
        merge_to,
        source_remote,
        skip_audit,
        allow_untracked,
        force_finalize_while_running,
        audit_model,
      },
      ctx: DispatchContext,
    ) => {
      const record = deps.registry.get(worker_id);
      if (!record) {
        return {
          content: [{ type: 'text', text: `Unknown worker '${worker_id}'.` }],
          isError: true,
        };
      }

      // M3: terminal-status guard. Running/spawning workers race pending writes.
      // Tier-3 + `force_finalize_while_running: true` bypass for edge cases.
      if (!TERMINAL_WORKER_STATUSES.includes(record.status)) {
        if (force_finalize_while_running !== true) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `finalize: worker '${worker_id}' is ${record.status}; wait for completion or kill_worker first `
                  + '(or pass force_finalize_while_running:true at tier 3).',
              },
            ],
            isError: true,
          };
        }
        if (ctx.tier < 3) {
          return {
            content: [
              {
                type: 'text',
                text: `finalize(force_finalize_while_running=true) requires tier 3 (confirm). Current tier: ${ctx.tier}.`,
              },
            ],
            isError: true,
          };
        }
      }

      if (merge_to !== undefined && ctx.tier < 3) {
        return {
          content: [
            {
              type: 'text',
              text: `finalize(merge_to=${merge_to}) requires tier 3 (confirm). Current tier: ${ctx.tier}.`,
            },
          ],
          isError: true,
        };
      }
      if (skip_audit === true && ctx.tier < 3) {
        return {
          content: [
            {
              type: 'text',
              text: `finalize(skip_audit=true) requires tier 3 (confirm). Current tier: ${ctx.tier}.`,
            },
          ],
          isError: true,
        };
      }
      if (allow_untracked === true && ctx.tier < 3) {
        return {
          content: [
            {
              type: 'text',
              text: `finalize(allow_untracked=true) requires tier 3 (confirm). Current tier: ${ctx.tier}.`,
            },
          ],
          isError: true,
        };
      }

      const branch = await currentBranch(record.worktreePath, ctx.signal);
      if (branch === null) {
        return {
          content: [
            {
              type: 'text',
              text: 'Worker worktree is in detached-HEAD state; cannot push a branch.',
            },
          ],
          isError: true,
        };
      }

      const project = resolveProjectForWorker(deps.projectStore, record);
      const repoPath = path.resolve(project.path);
      if (merge_to !== undefined && path.resolve(record.worktreePath) === repoPath) {
        return {
          content: [
            {
              type: 'text',
              text:
                'finalize(merge_to=...) requires a worker worktree distinct from the project root. '
                + 'This worker appears to be running in the main repo itself.',
            },
          ],
          isError: true,
        };
      }

      const commitMessage =
        commit_message !== undefined && commit_message.trim().length > 0
          ? commit_message
          : defaultCommitMessage(record);

      // C1: refuse to ship untracked files unless tier-3 + allow_untracked.
      // The auditor only sees untracked filenames, never content (see
      // git-ops.diffWorktree). `git add -A` then commits those bytes —
      // bypassing audit review. Closing the hole by construction.
      let untrackedFiles: readonly string[];
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['ls-files', '--others', '--exclude-standard'],
          {
            cwd: record.worktreePath,
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          },
        );
        untrackedFiles = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `finalize: could not enumerate untracked files: ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
          ],
          isError: true,
        };
      }
      if (untrackedFiles.length > 0 && allow_untracked !== true) {
        return {
          content: [
            {
              type: 'text',
              text: [
                `finalize: ${untrackedFiles.length} untracked file${
                  untrackedFiles.length === 1 ? '' : 's'
                } present — auditor cannot see their content. Stage them first (so the diff includes the contents) or pass allow_untracked:true at tier 3.`,
                '',
                'Untracked:',
                ...untrackedFiles.slice(0, 20).map((f) => `  - ${f}`),
                ...(untrackedFiles.length > 20
                  ? [`  ... and ${untrackedFiles.length - 20} more`]
                  : []),
              ].join('\n'),
            },
          ],
          isError: true,
        };
      }

      // M2: capture a worktree fingerprint before audit. If anything mutates
      // between now and the commit step, abort rather than ship un-audited
      // bytes. `git rev-parse HEAD` + SHA of `git status --porcelain=v1 -z`
      // is tight enough — any file-system change the index sees will flip
      // the porcelain hash.
      let fingerprintBefore: string;
      try {
        fingerprintBefore = await captureWorktreeFingerprint(record.worktreePath, ctx.signal);
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `finalize: could not capture worktree fingerprint: ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
          ],
          isError: true,
        };
      }

      const auditDeps: AuditChangesDeps = {
        registry: deps.registry,
        projectStore: deps.projectStore,
        ...(deps.oneShotRunner !== undefined ? { oneShotRunner: deps.oneShotRunner } : {}),
      };

      let cachedAuditResult: AuditResult | undefined;

      const auditRunner = async (): Promise<{ pass: boolean; detail: string }> => {
        if (skip_audit === true) {
          return { pass: true, detail: 'skipped (tier 3 escape hatch)' };
        }
        const outcome = await runAudit(auditDeps, {
          workerId: worker_id,
          ...(audit_model !== undefined ? { model: audit_model } : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        if (!outcome.ok) {
          return { pass: false, detail: `audit runner: ${outcome.message}` };
        }
        cachedAuditResult = outcome.result;
        return {
          pass: outcome.result.verdict === 'PASS',
          detail: `${outcome.result.verdict} · ${
            outcome.result.findings.length
          } finding${outcome.result.findings.length === 1 ? '' : 's'} · ${outcome.result.summary.slice(0, 200)}`,
        };
      };

      const finalizeConfig: FinalizeConfig = {
        ...(project.lintCommand !== undefined ? { lintCommand: project.lintCommand } : {}),
        ...(project.testCommand !== undefined ? { testCommand: project.testCommand } : {}),
        ...(project.buildCommand !== undefined ? { buildCommand: project.buildCommand } : {}),
        ...(project.verifyCommand !== undefined ? { verifyCommand: project.verifyCommand } : {}),
        ...(project.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: project.verifyTimeoutMs } : {}),
      };

      const preCommitFingerprintCheck = async (): Promise<
        { ok: true } | { ok: false; message: string }
      > => {
        try {
          const after = await captureWorktreeFingerprint(record.worktreePath, ctx.signal);
          if (after !== fingerprintBefore) {
            return {
              ok: false,
              message:
                'Worktree changed during finalize (post-audit mutation detected). '
                + 'Aborting before commit — re-run finalize after inspecting the worktree.',
            };
          }
          return { ok: true };
        } catch (err) {
          return {
            ok: false,
            message: `Could not re-verify worktree fingerprint: ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
      };

      let result: FinalizeRunResult;
      try {
        result = await finalizeRunner({
          worktreePath: record.worktreePath,
          repoPath,
          featureBranch: branch,
          commitMessage,
          ...(merge_to !== undefined ? { mergeTo: merge_to } : {}),
          ...(source_remote !== undefined ? { sourceRemote: source_remote } : {}),
          config: finalizeConfig,
          auditRunner,
          preCommitCheck: preCommitFingerprintCheck,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `finalize raised: ${msg}` }],
          isError: true,
        };
      }

      const text = formatFinalizeText({
        workerId: worker_id,
        featureBranch: branch,
        mergeTo: merge_to,
        result,
        skipAudit: skip_audit === true,
      });

      return {
        content: [{ type: 'text', text }],
        structuredContent: buildStructured({
          workerId: worker_id,
          branch,
          mergeTo: merge_to,
          commitMessage,
          result,
          auditResult: cachedAuditResult,
          skipAudit: skip_audit === true,
        }),
        isError: !result.ok,
      };
    },
  };
}

/**
 * M2: opaque fingerprint of the worktree's observable state.
 * `git rev-parse HEAD` + sha of `git status --porcelain=v1 -z`. Any change
 * the index would see (new/renamed/modified/staged/untracked path) flips
 * the porcelain hash, catching mutation in the audit-to-commit window.
 */
async function captureWorktreeFingerprint(
  worktreePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const execOptions = {
    cwd: worktreePath,
    ...(signal !== undefined ? { signal } : {}),
  };
  const [head, status] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], execOptions),
    execFileAsync('git', ['status', '--porcelain=v1', '-z'], execOptions),
  ]);
  const statusSha = await (async () => {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(status.stdout).digest('hex');
  })();
  return `${head.stdout.trim()}::${statusSha}`;
}

function defaultCommitMessage(record: WorkerRecord): string {
  const role = record.role.toLowerCase();
  const intent = record.featureIntent.trim();
  if (intent.length === 0) return `${role}: ship worker ${record.id}`;
  return `${role}: ${intent}`;
}

function resolveProjectForWorker(
  store: ProjectStore,
  record: WorkerRecord,
): Pick<
  ProjectRecord,
  | 'name'
  | 'path'
  | 'defaultModel'
  | 'lintCommand'
  | 'testCommand'
  | 'buildCommand'
  | 'verifyCommand'
  | 'verifyTimeoutMs'
  | 'finalizeDefault'
> {
  const resolved = path.resolve(record.projectPath);
  for (const candidate of store.list()) {
    if (path.resolve(candidate.path) === resolved) {
      return {
        name: candidate.name,
        path: candidate.path,
        ...(candidate.defaultModel !== undefined
          ? { defaultModel: candidate.defaultModel }
          : {}),
        ...(candidate.lintCommand !== undefined ? { lintCommand: candidate.lintCommand } : {}),
        ...(candidate.testCommand !== undefined ? { testCommand: candidate.testCommand } : {}),
        ...(candidate.buildCommand !== undefined ? { buildCommand: candidate.buildCommand } : {}),
        ...(candidate.verifyCommand !== undefined
          ? { verifyCommand: candidate.verifyCommand }
          : {}),
        ...(candidate.verifyTimeoutMs !== undefined
          ? { verifyTimeoutMs: candidate.verifyTimeoutMs }
          : {}),
        ...(candidate.finalizeDefault !== undefined
          ? { finalizeDefault: candidate.finalizeDefault }
          : {}),
      };
    }
  }
  return { name: '(unregistered)', path: resolved };
}

interface FormatArgs {
  readonly workerId: string;
  readonly featureBranch: string;
  readonly mergeTo: string | undefined;
  readonly result: FinalizeRunResult;
  readonly skipAudit: boolean;
}

function formatFinalizeText(args: FormatArgs): string {
  const lines: string[] = [];
  lines.push(
    `finalize[${args.workerId}] branch=${args.featureBranch}${
      args.mergeTo !== undefined ? ` merge_to=${args.mergeTo}` : ''
    } → ${args.result.ok ? 'OK' : 'FAILED'}`,
  );
  if (args.skipAudit) lines.push('  (audit skipped — tier 3 escape hatch)');
  for (const step of args.result.steps) {
    lines.push(formatStepLine(step));
  }
  if (args.result.failedAt !== undefined) {
    lines.push(`stopped at: ${args.result.failedAt}`);
  }
  if (args.result.commitSha !== undefined) {
    lines.push(`commit: ${args.result.commitSha.slice(0, 7)}`);
  }
  if (args.result.mergeSha !== undefined) {
    lines.push(`merge: ${args.result.mergeSha.slice(0, 7)}`);
  }
  return lines.join('\n');
}

function formatStepLine(step: FinalizeStepOutcome): string {
  const marker = {
    ok: '✓',
    failed: '✗',
    skipped: '∅',
    aborted: '⚠',
  }[step.status];
  const detail = step.detail !== undefined ? ` · ${step.detail}` : '';
  return `  ${marker} ${step.step} (${step.durationMs}ms)${detail}`;
}

interface BuildStructuredArgs {
  readonly workerId: string;
  readonly branch: string;
  readonly mergeTo: string | undefined;
  readonly commitMessage: string;
  readonly result: FinalizeRunResult;
  readonly auditResult: AuditResult | undefined;
  readonly skipAudit: boolean;
}

function buildStructured(args: BuildStructuredArgs): Record<string, unknown> {
  return {
    worker_id: args.workerId,
    feature_branch: args.branch,
    merge_to: args.mergeTo ?? null,
    commit_message: args.commitMessage,
    ok: args.result.ok,
    failed_at: args.result.failedAt ?? null,
    commit_sha: args.result.commitSha ?? null,
    merge_sha: args.result.mergeSha ?? null,
    skip_audit: args.skipAudit,
    steps: args.result.steps as unknown as Record<string, unknown>[],
    audit: args.auditResult
      ? ({
          verdict: args.auditResult.verdict,
          findings_count: args.auditResult.findings.length,
          summary: args.auditResult.summary,
        } as unknown as Record<string, unknown>)
      : null,
  };
}
