import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { ProjectConfigInput } from '../projects/types.js';
import type { SymphonyConfig } from './types.js';

/**
 * Read `.symphony.json` from the project root. Returns null on missing file
 * or parse error. Parse errors are swallowed on purpose — a malformed
 * config must not crash worktree creation.
 *
 * Phase 5A: this reader is the legacy path — `preservePatterns`,
 * `lifecycleScripts`, `worktreePool`, top-level `maxConcurrentWorkers`.
 * The new `project` section is read via `readProjectConfig` below, which
 * Zod-validates and returns a `Partial<ProjectConfigInput>` overlay.
 */
export function readSymphonyConfig(projectPath: string): SymphonyConfig | null {
  const configPath = path.join(projectPath, '.symphony.json');
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as SymphonyConfig;
  } catch {
    return null;
  }
}

/**
 * Phase 5A — Zod schema for the `project` section of `.symphony.json`.
 * STRICT mode: unknown keys cause Zod to fail-parse so typos surface
 * immediately. PLAN.md §Phase 5 (lines 1944–1982) is the field-list
 * source of truth — the drift-lock test pins agreement.
 *
 * Value-range validation lives here (not in SQL) so migration 0009 stays
 * purely additive and runtime errors are actionable (Zod errors carry
 * the offending field path and reason, vs SQLITE_CONSTRAINT which only
 * reports the column).
 */
export const ProjectSectionSchema = z
  .object({
    name: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    worktreeDir: z.string().min(1).optional(),
    mcpConfig: z.string().min(1).optional(),
    maxConcurrentWorkers: z.number().int().min(1).max(32).optional(),
    qualityPipeline: z.enum(['full', 'simplified', 'none']).optional(),
    planModeRequired: z.boolean().optional(),
    defaultAutonomyTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    previewCommand: z.string().min(1).optional(),
    previewTimeoutMs: z.number().int().min(1).optional(),
    testCommand: z.string().min(1).optional(),
    buildCommand: z.string().min(1).optional(),
    lintCommand: z.string().min(1).optional(),
    verifyCommand: z.string().min(1).optional(),
    verifyTimeoutMs: z.number().int().min(1).optional(),
    finalizeDefault: z.enum(['push', 'merge']).optional(),
    maestroWarmth: z.number().min(0).max(1).optional(),
    droidsDir: z.string().min(1).optional(),
    designInspiration: z.string().min(1).nullable().optional(),
    gitRemote: z.string().min(1).optional(),
    gitBranch: z.string().min(1).optional(),
    baseRef: z.string().min(1).optional(),
    // Phase 5A audit-m4: accept `previewUrl` in strict mode so users
    // can write it without a Zod rejection. NOT propagated to the
    // overlay — `verify_ui` (4G.2) reads the URL from the
    // `previewCommand` stdout banner, not from this field. Persistence
    // wires up in 5B/5F when a TUI panel needs the value.
    previewUrl: z.string().min(1).optional(),
  })
  .strict();

export type ParsedProjectSection = z.infer<typeof ProjectSectionSchema>;

/**
 * Field names declared in PLAN.md's `.symphony.json` schema (lines
 * 1950–1972) that are intentionally NOT persisted by Phase 5A. The
 * drift-lock test excludes these from the schema-vs-PLAN comparison.
 *
 * Currently empty: `previewUrl` was on this list pre-audit-m4 but now
 * lives in the Zod schema as a no-op-accepted field (audit-m4 fix).
 * Add fields here when a new PLAN.md field should be temporarily
 * tolerated without code support.
 */
export const PHASE_5A_DEFERRED_FIELDS: readonly string[] = [];

export interface ReadProjectConfigResult {
  /** Overlay merged into ProjectConfigInput. Null on missing file / Zod failure. */
  readonly overlay: Partial<ProjectConfigInput> | null;
  /** Diagnostic messages — empty when the file parses cleanly. */
  readonly warnings: readonly string[];
  /** Parsed but informational — used by 5B to consistency-check against the registered name. */
  readonly declaredName?: string;
}

/**
 * Phase 5A — read `<projectPath>/.symphony.json`, extract + validate
 * the `project` section, return a `ProjectConfigInput` overlay.
 *
 * Tolerance contract:
 *   - missing file → `{overlay: null, warnings: []}` (silent, common path)
 *   - malformed JSON → `{overlay: null, warnings: [...]}` (loud, won't crash boot)
 *   - root not an object → same as malformed JSON
 *   - no `project` key → `{overlay: null, warnings: []}` (legacy file shape)
 *   - `project` not an object → `{overlay: null, warnings: [...]}`
 *   - Zod failure on `project` → `{overlay: null, warnings: [...]}`
 *   - success → `{overlay: ProjectConfigInput-shaped, warnings: []}`
 *
 * `name` is parsed for type-validation but NOT included in the overlay
 * (the orchestrator's `options.projects` name→path map is authoritative
 * in 5A; 5B rewires this when CLI registration lands). Callers can use
 * `declaredName` to consistency-check.
 */
export function readProjectConfig(projectPath: string): ReadProjectConfigResult {
  const configPath = path.join(projectPath, '.symphony.json');
  let content: string;
  try {
    content = fs.readFileSync(configPath, 'utf8');
  } catch {
    return { overlay: null, warnings: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      overlay: null,
      warnings: [`${configPath}: malformed JSON (${(err as Error).message})`],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      overlay: null,
      warnings: [`${configPath}: root must be a JSON object`],
    };
  }
  const root = parsed as Record<string, unknown>;
  if (!('project' in root) || root.project === undefined) {
    return { overlay: null, warnings: [] };
  }
  if (!root.project || typeof root.project !== 'object' || Array.isArray(root.project)) {
    return {
      overlay: null,
      warnings: [`${configPath}: \`project\` must be a JSON object`],
    };
  }
  const result = ProjectSectionSchema.safeParse(root.project);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return {
      overlay: null,
      warnings: [`${configPath}: \`project\` failed validation — ${issues}`],
    };
  }
  const data = result.data;
  // Use a `-readonly` mapped intermediate so assignment compiles. The
  // final return shape is `Partial<ProjectConfigInput>` (readonly fields).
  type Mutable = { -readonly [K in keyof ProjectConfigInput]?: ProjectConfigInput[K] };
  const overlay: Mutable = {};
  // Copy field-by-field — `name` is dropped (informational only in 5A).
  if (data.defaultModel !== undefined) overlay.defaultModel = data.defaultModel;
  if (data.worktreeDir !== undefined) overlay.worktreeDir = data.worktreeDir;
  if (data.mcpConfig !== undefined) overlay.mcpConfig = data.mcpConfig;
  if (data.maxConcurrentWorkers !== undefined)
    overlay.maxConcurrentWorkers = data.maxConcurrentWorkers;
  if (data.qualityPipeline !== undefined) overlay.qualityPipeline = data.qualityPipeline;
  if (data.planModeRequired !== undefined) overlay.planModeRequired = data.planModeRequired;
  if (data.defaultAutonomyTier !== undefined)
    overlay.defaultAutonomyTier = data.defaultAutonomyTier;
  if (data.previewCommand !== undefined) overlay.previewCommand = data.previewCommand;
  if (data.previewTimeoutMs !== undefined) overlay.previewTimeoutMs = data.previewTimeoutMs;
  if (data.testCommand !== undefined) overlay.testCommand = data.testCommand;
  if (data.buildCommand !== undefined) overlay.buildCommand = data.buildCommand;
  if (data.lintCommand !== undefined) overlay.lintCommand = data.lintCommand;
  if (data.verifyCommand !== undefined) overlay.verifyCommand = data.verifyCommand;
  if (data.verifyTimeoutMs !== undefined) overlay.verifyTimeoutMs = data.verifyTimeoutMs;
  if (data.finalizeDefault !== undefined) overlay.finalizeDefault = data.finalizeDefault;
  if (data.maestroWarmth !== undefined) overlay.maestroWarmth = data.maestroWarmth;
  if (data.droidsDir !== undefined) overlay.droidsDir = data.droidsDir;
  // `designInspiration` is the only nullable field — null collapses to
  // undefined in the overlay (SQL stores undefined as NULL anyway; the
  // round-trip is lossless for "design not yet picked" semantics).
  if (data.designInspiration !== undefined && data.designInspiration !== null)
    overlay.designInspiration = data.designInspiration;
  if (data.gitRemote !== undefined) overlay.gitRemote = data.gitRemote;
  if (data.gitBranch !== undefined) overlay.gitBranch = data.gitBranch;
  if (data.baseRef !== undefined) overlay.baseRef = data.baseRef;
  return {
    overlay,
    warnings: [],
    ...(data.name !== undefined ? { declaredName: data.name } : {}),
  };
}
