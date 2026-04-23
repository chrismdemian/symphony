import path from 'node:path';
import { z } from 'zod';
import type { ProjectRecord, ProjectStore } from '../../projects/types.js';
import { currentBranch, diffWorktree, DEFAULT_DIFF_SIZE_CAP_BYTES } from '../git-ops.js';
import {
  defaultOneShotRunner,
  parseStructuredResponse,
  type OneShotRunner,
} from '../one-shot.js';
import type { ToolRegistration } from '../registry.js';
import type { DispatchContext } from '../types.js';
import type { WorkerRegistry, WorkerRecord } from '../worker-registry.js';

// Larger than `review_diff`'s 50KB default — the reviewer needs full context
// for an accurate verdict.
const DEFAULT_AUDIT_DIFF_CAP_BYTES = 100_000;
const DEFAULT_AUDIT_TIMEOUT_MS = 180_000;

type Severity = 'Critical' | 'Major' | 'Minor';

export interface AuditFinding {
  readonly severity: Severity;
  readonly location: string;
  readonly description: string;
  readonly cite?: string;
}

export interface AuditResult {
  readonly verdict: 'PASS' | 'FAIL';
  readonly findings: readonly AuditFinding[];
  readonly summary: string;
  readonly workerId: string;
  readonly branch: string | null;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly sessionId?: string;
  readonly durationMs: number;
}

export interface RunAuditInput {
  readonly workerId: string;
  readonly baseRef?: string;
  readonly capBytes?: number;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface AuditChangesDeps {
  readonly registry: WorkerRegistry;
  readonly projectStore: ProjectStore;
  readonly oneShotRunner?: OneShotRunner;
}

export type AuditOutcome =
  | { readonly ok: true; readonly result: AuditResult }
  | { readonly ok: false; readonly message: string; readonly rawStdout?: string };

/**
 * Shared audit core — used directly by `finalize` and wrapped by the
 * `audit_changes` MCP tool. Extracted so both call sites exercise the
 * same code path.
 */
export async function runAudit(
  deps: AuditChangesDeps,
  input: RunAuditInput,
): Promise<AuditOutcome> {
  const runner = deps.oneShotRunner ?? defaultOneShotRunner;
  const record = deps.registry.get(input.workerId);
  if (!record) {
    return { ok: false, message: `Unknown worker '${input.workerId}'.` };
  }

  const capBytes = input.capBytes ?? DEFAULT_AUDIT_DIFF_CAP_BYTES;
  const diff = await diffWorktree({
    worktreePath: record.worktreePath,
    capBytes,
    ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  const branch = await currentBranch(record.worktreePath, input.signal);
  const project = resolveProjectForWorker(deps.projectStore, record);
  // TODO(phase-4c): extract this prompt into `fragments/worker-role-reviewer.md`.
  const prompt = buildAuditPrompt({
    featureIntent: record.featureIntent,
    projectName: project.name,
    projectPath: project.path,
    branch,
    fileCount: diff.files.length,
    diffBody: diff.diff,
    truncated: diff.truncated,
    bytes: diff.bytes,
  });

  const resolvedModel = input.model ?? project.defaultModel;

  const start = Date.now();
  let runnerResult;
  try {
    runnerResult = await runner({
      prompt,
      cwd: project.path,
      timeoutMs: input.timeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS,
      ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `one-shot runner failed: ${msg}` };
  }

  const parsed = parseStructuredResponse<unknown>(runnerResult.text, {
    requiredFields: ['verdict', 'findings'],
  });
  const normalized = normalizeAuditPayload(parsed);
  if (normalized === null) {
    return {
      ok: false,
      message: 'Reviewer did not return a valid verdict JSON.',
      rawStdout: runnerResult.rawStdout,
    };
  }

  return {
    ok: true,
    result: {
      verdict: normalized.verdict,
      findings: normalized.findings,
      summary: normalized.summary,
      workerId: record.id,
      branch,
      bytes: diff.bytes,
      truncated: diff.truncated,
      ...(runnerResult.sessionId !== undefined ? { sessionId: runnerResult.sessionId } : {}),
      durationMs: Date.now() - start,
    },
  };
}

function resolveProjectForWorker(
  store: ProjectStore,
  record: WorkerRecord,
): Pick<ProjectRecord, 'name' | 'path' | 'defaultModel'> {
  const resolved = path.resolve(record.projectPath);
  for (const candidate of store.list()) {
    if (path.resolve(candidate.path) === resolved) {
      return {
        name: candidate.name,
        path: candidate.path,
        ...(candidate.defaultModel !== undefined ? { defaultModel: candidate.defaultModel } : {}),
      };
    }
  }
  return { name: '(unregistered)', path: resolved };
}

interface BuildPromptArgs {
  readonly featureIntent: string;
  readonly projectName: string;
  readonly projectPath: string;
  readonly branch: string | null;
  readonly fileCount: number;
  readonly diffBody: string;
  readonly truncated: boolean;
  readonly bytes: number;
}

function buildAuditPrompt(args: BuildPromptArgs): string {
  const header = [
    'You are an independent code auditor reviewing a worker\'s diff.',
    '',
    `Worker intent: ${args.featureIntent || '(unspecified)'}`,
    `Project: ${args.projectName} at ${args.projectPath}`,
    `Branch: ${args.branch ?? '(detached HEAD)'}`,
    `Files changed: ${args.fileCount}`,
    `Diff size: ${args.bytes} bytes${args.truncated ? ' (TRUNCATED — body may be incomplete)' : ''}`,
    '',
    'Review this diff skeptically. Default assumption: the worker introduced a bug.',
    'Describe what you actually observe, not what you expect. Cite exact code snippets.',
    '',
    'Classify each issue you find:',
    '- Critical: breaks correctness, security, or data integrity. PASS requires zero Critical findings.',
    '- Major: real problem that should be fixed before ship (bad pattern, missing test, regression risk).',
    '- Minor: style, micro-optimization, advisory — will not block.',
    '',
    'Return ONLY a single JSON object. No commentary, no markdown fences. Exact shape:',
    '',
    '{',
    '  "verdict": "PASS" | "FAIL",',
    '  "findings": [',
    '    {',
    '      "severity": "Critical" | "Major" | "Minor",',
    '      "location": "path/to/file.ext:lineNumber",',
    '      "description": "one-line explanation",',
    '      "cite": "exact snippet from the diff"',
    '    }',
    '  ],',
    '  "summary": "2-4 sentence overall assessment"',
    '}',
    '',
    'PASS iff there are NO Critical findings. Major and Minor findings are allowed in a PASS verdict but must be cited precisely so the worker can address them.',
    '',
    'Diff:',
    '```diff',
    args.diffBody || '(no diff)',
    '```',
  ];
  return header.join('\n');
}

interface NormalizedPayload {
  readonly verdict: 'PASS' | 'FAIL';
  readonly findings: readonly AuditFinding[];
  readonly summary: string;
}

function normalizeAuditPayload(raw: unknown): NormalizedPayload | null {
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const verdictRaw = obj.verdict;
  if (verdictRaw !== 'PASS' && verdictRaw !== 'FAIL') return null;
  const findingsRaw = obj.findings;
  if (!Array.isArray(findingsRaw)) return null;
  const findings: AuditFinding[] = [];
  for (const entry of findingsRaw) {
    if (entry === null || typeof entry !== 'object') continue;
    const f = entry as Record<string, unknown>;
    const severity = f.severity;
    if (severity !== 'Critical' && severity !== 'Major' && severity !== 'Minor') continue;
    const location = typeof f.location === 'string' ? f.location : '';
    const description = typeof f.description === 'string' ? f.description : '';
    if (description.length === 0) continue;
    findings.push({
      severity: severity as Severity,
      location,
      description,
      ...(typeof f.cite === 'string' && f.cite.length > 0 ? { cite: f.cite } : {}),
    });
  }
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  return {
    verdict: verdictRaw,
    findings,
    summary,
  };
}

// ---------------------------------------------------------------------------
// MCP tool wrapper
// ---------------------------------------------------------------------------

const shape = {
  worker_id: z
    .string()
    .min(1)
    .describe('Worker id whose diff should be audited.'),
  model: z
    .string()
    .optional()
    .describe('Reviewer model. Defaults to the project `defaultModel` or the Claude CLI default.'),
  base_ref: z
    .string()
    .optional()
    .describe('Git ref to diff against. Default HEAD.'),
  cap_bytes: z
    .number()
    .int()
    .min(1_000)
    .max(500_000)
    .optional()
    .describe(`Truncate the diff body above this many bytes. Default ${DEFAULT_AUDIT_DIFF_CAP_BYTES}. ${DEFAULT_DIFF_SIZE_CAP_BYTES}-byte `
      + 'review_diff default is narrower because audits need richer context.'),
  timeout_ms: z
    .number()
    .int()
    .min(30_000)
    .max(600_000)
    .optional()
    .describe(`Reviewer timeout in ms. Default ${DEFAULT_AUDIT_TIMEOUT_MS}.`),
};

export function makeAuditChangesTool(
  deps: AuditChangesDeps,
): ToolRegistration<typeof shape> {
  return {
    name: 'audit_changes',
    description:
      "Spawn an independent reviewer over a worker's diff. Returns PASS/FAIL with cited findings. Writer never audits its own work — this is the ground-truth gate before `finalize`. act-mode only.",
    scope: 'act',
    capabilities: [],
    inputSchema: shape,
    handler: async (
      { worker_id, model, base_ref, cap_bytes, timeout_ms },
      ctx: DispatchContext,
    ) => {
      const outcome = await runAudit(deps, {
        workerId: worker_id,
        ...(model !== undefined ? { model } : {}),
        ...(base_ref !== undefined ? { baseRef: base_ref } : {}),
        ...(cap_bytes !== undefined ? { capBytes: cap_bytes } : {}),
        ...(timeout_ms !== undefined ? { timeoutMs: timeout_ms } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      });

      if (!outcome.ok) {
        return {
          content: [{ type: 'text', text: `audit_changes failed: ${outcome.message}` }],
          isError: true,
          ...(outcome.rawStdout !== undefined
            ? {
                structuredContent: {
                  raw_stdout_tail:
                    outcome.rawStdout.length > 2000
                      ? outcome.rawStdout.slice(-2000)
                      : outcome.rawStdout,
                } as unknown as Record<string, unknown>,
              }
            : {}),
        };
      }

      const r = outcome.result;
      const findingsTable = r.findings.length === 0
        ? '(no findings)'
        : r.findings
            .map((f) => `- [${f.severity}] ${f.location || '(no location)'} — ${f.description}`)
            .join('\n');
      const text = [
        `audit: ${r.verdict}`,
        '',
        r.summary,
        '',
        `Findings (${r.findings.length}):`,
        findingsTable,
      ].join('\n');

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          verdict: r.verdict,
          findings: r.findings as unknown as Record<string, unknown>[],
          summary: r.summary,
          worker_id: r.workerId,
          branch: r.branch,
          bytes: r.bytes,
          truncated: r.truncated,
          duration_ms: r.durationMs,
          ...(r.sessionId !== undefined ? { session_id: r.sessionId } : {}),
        },
        isError: r.verdict === 'FAIL',
      };
    },
  };
}
