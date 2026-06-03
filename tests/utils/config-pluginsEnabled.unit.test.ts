/**
 * Phase 7A — `pluginsEnabled` schema + 5-site cascade lock.
 *
 * The master switch is easy to silently break (the schema-default refills
 * on re-read, masking a dropped write). This pins all 5 sites: schema
 * default + parse, mergePatch (disk), applyPatchInMemory (TUI), and
 * applyConfigEdits (disk write).
 */
import { describe, expect, it } from 'vitest';

import { SymphonyConfigSchema, defaultConfig } from '../../src/utils/config-schema.js';
import { applyConfigEdits } from '../../src/utils/config.js';
import { applyPatchInMemory } from '../../src/utils/config-context.js';

describe('Phase 7A — pluginsEnabled schema + cascade', () => {
  it('defaults to false (default-deny)', () => {
    expect(defaultConfig().pluginsEnabled).toBe(false);
  });

  it('accepts true explicitly', () => {
    expect(SymphonyConfigSchema.parse({ pluginsEnabled: true }).pluginsEnabled).toBe(true);
  });

  it('rejects a non-boolean at the Zod layer', () => {
    expect(SymphonyConfigSchema.safeParse({ pluginsEnabled: 'yes' }).success).toBe(false);
  });

  it('applyPatchInMemory carries it through (site 4)', () => {
    expect(applyPatchInMemory(defaultConfig(), { pluginsEnabled: true }).pluginsEnabled).toBe(true);
  });

  it('applyConfigEdits emits it (sites 3 + 5)', () => {
    const start = applyPatchInMemory(defaultConfig(), { pluginsEnabled: true });
    const text = applyConfigEdits('{}', start);
    expect(text).toContain('"pluginsEnabled"');
    expect(text).toContain('true');
  });

  it('round-trips parse → patch → emit → re-parse', () => {
    const start = applyPatchInMemory(defaultConfig(), { pluginsEnabled: true });
    const text = applyConfigEdits('{}', start);
    expect(SymphonyConfigSchema.parse(JSON.parse(text)).pluginsEnabled).toBe(true);
  });
});
