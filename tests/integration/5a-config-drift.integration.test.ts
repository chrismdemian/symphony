/**
 * Phase 5A — drift-lock between PLAN.md's `.symphony.json` schema example
 * (lines 1950–1972) and the `ProjectSectionSchema` Zod schema.
 *
 * The PLAN-side example documents the user-facing config surface; the
 * code-side Zod schema validates it. Without a pin, the two skew silently
 * — a field added to the prompt example never lands in code, or a code
 * field never gets documented for users.
 *
 * This test parses PLAN.md, extracts every `"key": value,` line inside
 * the `<project>/.symphony.json` JSON example, and asserts:
 *   1. Every PLAN.md key appears in `ProjectSectionSchema.shape` OR
 *      is on the `PHASE_5A_DEFERRED_FIELDS` allowlist.
 *   2. Every key in `ProjectSectionSchema.shape` appears in PLAN.md.
 *
 * Mirrors the 4G.1 `audit-loop-constants` drift-lock pattern.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PHASE_5A_DEFERRED_FIELDS,
  ProjectSectionSchema,
} from '../../src/worktree/symphony-config.js';

/**
 * Locate PLAN.md by walking up from cwd. PLAN.md is gitignored (it's a
 * local-only planning doc, not shared via git), so worktrees + CI
 * checkouts don't carry it. Tests running inside a worktree traverse
 * up to find the main repo's copy. Returns null when not found — the
 * drift-lock assertions skip gracefully in that case (the Zod schema
 * is the runtime authority; PLAN.md is a user-facing reference).
 */
function resolvePlanPath(): string | null {
  let dir = process.cwd();
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = path.join(dir, 'PLAN.md');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function extractPlanSymphonyJsonKeys(): string[] | null {
  const planPath = resolvePlanPath();
  if (planPath === null) return null;
  const lines = readFileSync(planPath, 'utf8').split(/\r?\n/);
  // Find the Phase 5 `.symphony.json` JSON block. Anchor on the fenced
  // block opener that follows the `<project>/.symphony.json` mention.
  const headerIdx = lines.findIndex((l) =>
    /Project config file:\s*`<project>\/\.symphony\.json`/.test(l),
  );
  if (headerIdx < 0) throw new Error('PLAN.md: could not locate Phase 5 .symphony.json header');
  // Find the opening fence (` ```json `) below the header.
  let fenceStart = -1;
  for (let i = headerIdx; i < lines.length; i += 1) {
    if (/^\s*```json\s*$/.test(lines[i]!)) {
      fenceStart = i;
      break;
    }
  }
  if (fenceStart < 0) throw new Error('PLAN.md: could not locate ```json fence');
  // Find the closing fence.
  let fenceEnd = -1;
  for (let i = fenceStart + 1; i < lines.length; i += 1) {
    if (/^\s*```\s*$/.test(lines[i]!)) {
      fenceEnd = i;
      break;
    }
  }
  if (fenceEnd < 0) throw new Error('PLAN.md: could not locate closing fence');
  const body = lines.slice(fenceStart + 1, fenceEnd);
  const keys: string[] = [];
  const keyRe = /^\s*"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/;
  for (const line of body) {
    const m = line.match(keyRe);
    if (m && m[1]) keys.push(m[1]);
  }
  // Dedup + preserve order
  return Array.from(new Set(keys));
}

describe('Phase 5A — drift lock: PLAN.md ↔ ProjectSectionSchema', () => {
  const planKeys = extractPlanSymphonyJsonKeys();
  const schemaKeys = Object.keys(ProjectSectionSchema.shape);
  const skipReason = planKeys === null ? 'PLAN.md not found (CI or fresh checkout)' : null;

  it.skipIf(skipReason !== null)('PLAN.md extracts a non-empty key list (sanity)', () => {
    expect(planKeys!.length).toBeGreaterThan(10);
  });

  it.skipIf(skipReason !== null)(
    'every PLAN.md key has a Zod schema entry OR is on the deferred list',
    () => {
      const missing: string[] = [];
      for (const k of planKeys!) {
        if (schemaKeys.includes(k)) continue;
        if (PHASE_5A_DEFERRED_FIELDS.includes(k)) continue;
        missing.push(k);
      }
      expect(
        missing,
        `PLAN.md keys not in ProjectSectionSchema and not deferred: ${missing.join(', ')}`,
      ).toEqual([]);
    },
  );

  it.skipIf(skipReason !== null)('every Zod schema key appears in PLAN.md', () => {
    const missing: string[] = [];
    for (const k of schemaKeys) {
      if (planKeys!.includes(k)) continue;
      missing.push(k);
    }
    expect(
      missing,
      `ProjectSectionSchema keys not documented in PLAN.md: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it.skipIf(skipReason !== null)(
    '`PHASE_5A_DEFERRED_FIELDS` keys are all in PLAN.md (so the deferral pin remains valid)',
    () => {
      const orphan: string[] = [];
      for (const k of PHASE_5A_DEFERRED_FIELDS) {
        if (!planKeys!.includes(k)) orphan.push(k);
      }
      expect(orphan, `deferred fields no longer present in PLAN.md: ${orphan.join(', ')}`).toEqual(
        [],
      );
    },
  );
});
