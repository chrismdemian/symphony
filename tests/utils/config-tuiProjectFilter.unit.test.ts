/**
 * Phase 5F — `tuiProjectFilter` schema + 5-site cascade.
 *
 * Validates that the field:
 *   - parses as 'all' by default
 *   - accepts 'active' explicitly
 *   - rejects other strings at the Zod layer
 *   - round-trips through `mergePatch` (config.ts) and
 *     `applyPatchInMemory` (config-context.tsx)
 *   - lands in `applyConfigEdits` so disk writes don't drop it
 */
import { describe, expect, it } from 'vitest';

import {
  SymphonyConfigSchema,
  defaultConfig,
} from '../../src/utils/config-schema.js';
import { applyConfigEdits } from '../../src/utils/config.js';
import { applyPatchInMemory } from '../../src/utils/config-context.js';

describe('Phase 5F — tuiProjectFilter schema + cascade', () => {
  it('defaults to "all"', () => {
    const config = defaultConfig();
    expect(config.tuiProjectFilter).toBe('all');
  });

  it('accepts "active" explicitly', () => {
    const parsed = SymphonyConfigSchema.parse({ tuiProjectFilter: 'active' });
    expect(parsed.tuiProjectFilter).toBe('active');
  });

  it('rejects unknown values at the Zod layer', () => {
    const result = SymphonyConfigSchema.safeParse({ tuiProjectFilter: 'maybe' });
    expect(result.success).toBe(false);
  });

  it('applyPatchInMemory carries tuiProjectFilter through (TUI-side, site 4)', () => {
    const next = applyPatchInMemory(defaultConfig(), { tuiProjectFilter: 'active' });
    expect(next.tuiProjectFilter).toBe('active');
  });

  it('applyConfigEdits emits tuiProjectFilter into the JSONC text (sites 3 + 5)', () => {
    // `applyConfigEdits(existing, next)` is the public seam; mergePatch
    // and the field-list are private (site 3 + 5 are exercised
    // transitively). If either site dropped the field, the emitted
    // text would NOT contain `tuiProjectFilter`. Defense for the
    // 5-site cascade audit pattern.
    const start = applyPatchInMemory(defaultConfig(), { tuiProjectFilter: 'active' });
    const text = applyConfigEdits('{}', start);
    expect(text).toContain('"tuiProjectFilter"');
    expect(text).toContain('"active"');
  });

  it('round-trip preserves tuiProjectFilter (parse → patch → emit → re-parse)', () => {
    const start = applyPatchInMemory(defaultConfig(), { tuiProjectFilter: 'active' });
    const text = applyConfigEdits('{}', start);
    const reparsed = SymphonyConfigSchema.parse(JSON.parse(text));
    expect(reparsed.tuiProjectFilter).toBe('active');
  });
});
