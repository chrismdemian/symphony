import { describe, it, expect } from 'vitest';

import { defaultConfig, parseConfig } from '../../src/utils/config-schema.js';
import type { applyPatchInMemory as ApplyPatchInMemory } from '../../src/utils/config-context.js';

describe('voice config — defaults', () => {
  it('parses an empty object with voice defaults', () => {
    const cfg = defaultConfig();
    expect(cfg.voice).toEqual({
      enabled: false,
      vadThreshold: 0.5,
      vadMinSpeechMs: 100,
      vadMinSilenceMs: 400,
      // Phase 6B fields
      sttModel: 'moonshine/base',
      maxUtteranceSeconds: 30,
      partialIntervalMs: 200,
    });
  });

  it('parseConfig({}) → defaults, zero warnings', () => {
    const { config, warnings } = parseConfig({});
    expect(config.voice.enabled).toBe(false);
    expect(config.voice.vadThreshold).toBe(0.5);
    expect(config.voice.sttModel).toBe('moonshine/base');
    expect(config.voice.maxUtteranceSeconds).toBe(30);
    expect(config.voice.partialIntervalMs).toBe(200);
    expect(warnings).toEqual([]);
  });
});

describe('voice config — explicit values', () => {
  it('accepts user-set threshold within range', () => {
    const { config, warnings } = parseConfig({
      voice: { enabled: true, vadThreshold: 0.7, vadMinSpeechMs: 150, vadMinSilenceMs: 500 },
    });
    expect(config.voice.enabled).toBe(true);
    expect(config.voice.vadThreshold).toBe(0.7);
    expect(config.voice.vadMinSpeechMs).toBe(150);
    expect(config.voice.vadMinSilenceMs).toBe(500);
    expect(warnings).toEqual([]);
  });

  it('preserves user partial — fills missing fields from defaults', () => {
    const { config } = parseConfig({
      voice: { enabled: true },
    });
    expect(config.voice.enabled).toBe(true);
    // Missing fields filled by schema defaults
    expect(config.voice.vadThreshold).toBe(0.5);
    expect(config.voice.vadMinSpeechMs).toBe(100);
  });
});

describe('voice config — salvage on bad values', () => {
  it('warns + drops the voice field on out-of-range threshold', () => {
    const { config, warnings } = parseConfig({
      voice: { vadThreshold: 1.5 },
    });
    // Field salvage drops the whole voice object, schema defaults
    // back-fill — same shape as the 3H.1 m2 trade-off.
    expect(config.voice.vadThreshold).toBe(0.5);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join(' ')).toMatch(/voice/i);
  });

  it('warns + drops the voice field on out-of-range min-silence', () => {
    const { config, warnings } = parseConfig({
      voice: { vadMinSilenceMs: 50_000 },
    });
    expect(config.voice.vadMinSilenceMs).toBe(400);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('warns + drops on non-numeric threshold', () => {
    const { config, warnings } = parseConfig({
      voice: { vadThreshold: 'loud' },
    });
    expect(config.voice.vadThreshold).toBe(0.5);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('warns + drops the whole voice block when its type is wrong', () => {
    const { config, warnings } = parseConfig({
      voice: 'enabled',
    });
    expect(config.voice).toEqual({
      enabled: false,
      vadThreshold: 0.5,
      vadMinSpeechMs: 100,
      vadMinSilenceMs: 400,
      sttModel: 'moonshine/base',
      maxUtteranceSeconds: 30,
      partialIntervalMs: 200,
    });
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('voice config — Phase 6B STT fields', () => {
  it('accepts moonshine/tiny as a valid sttModel', () => {
    const { config, warnings } = parseConfig({
      voice: { sttModel: 'moonshine/tiny' },
    });
    expect(config.voice.sttModel).toBe('moonshine/tiny');
    expect(warnings).toEqual([]);
  });

  it('rejects unknown sttModel with a warning', () => {
    const { config, warnings } = parseConfig({
      voice: { sttModel: 'whisper-large' },
    });
    expect(config.voice.sttModel).toBe('moonshine/base');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('accepts maxUtteranceSeconds in [5, 90]', () => {
    const { config: low } = parseConfig({ voice: { maxUtteranceSeconds: 5 } });
    const { config: high } = parseConfig({ voice: { maxUtteranceSeconds: 90 } });
    expect(low.voice.maxUtteranceSeconds).toBe(5);
    expect(high.voice.maxUtteranceSeconds).toBe(90);
  });

  it('rejects maxUtteranceSeconds below 5', () => {
    const { config, warnings } = parseConfig({
      voice: { maxUtteranceSeconds: 1 },
    });
    expect(config.voice.maxUtteranceSeconds).toBe(30);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('rejects maxUtteranceSeconds above 90', () => {
    const { config, warnings } = parseConfig({
      voice: { maxUtteranceSeconds: 600 },
    });
    expect(config.voice.maxUtteranceSeconds).toBe(30);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('rejects non-integer maxUtteranceSeconds', () => {
    const { config, warnings } = parseConfig({
      voice: { maxUtteranceSeconds: 7.5 },
    });
    expect(config.voice.maxUtteranceSeconds).toBe(30);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('accepts partialIntervalMs in [100, 1000]', () => {
    const { config: low } = parseConfig({ voice: { partialIntervalMs: 100 } });
    const { config: high } = parseConfig({ voice: { partialIntervalMs: 1000 } });
    expect(low.voice.partialIntervalMs).toBe(100);
    expect(high.voice.partialIntervalMs).toBe(1000);
  });

  it('rejects partialIntervalMs below 100', () => {
    const { config, warnings } = parseConfig({
      voice: { partialIntervalMs: 50 },
    });
    expect(config.voice.partialIntervalMs).toBe(200);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('voice config — Phase 6B STT cascade', () => {
  it('partial-merge preserves untouched STT fields', async () => {
    const { mergePatchPublic } = await loadMergePatch();
    const baseline = defaultConfig();
    const seeded = {
      ...baseline,
      voice: { ...baseline.voice, sttModel: 'moonshine/tiny' as const, maxUtteranceSeconds: 45 },
    };
    const merged = mergePatchPublic(seeded, {
      voice: { partialIntervalMs: 350 },
    });
    expect(merged.voice.partialIntervalMs).toBe(350);
    // sttModel + maxUtteranceSeconds survive the partial merge
    expect(merged.voice.sttModel).toBe('moonshine/tiny');
    expect(merged.voice.maxUtteranceSeconds).toBe(45);
  });
});

describe('voice config — round-trip through 5-site cascade', () => {
  // This is a structural test: the 5 sites (schema, mergePatch,
  // applyPatchInMemory, applyConfigEdits, SymphonyConfigPatch) all
  // need to know the field. We exercise the in-process merge here;
  // the disk-write test in config.unit.test.ts (existing) covers the
  // applyConfigEdits path.

  it('voice partial merge preserves untouched fields', async () => {
    const { mergePatchPublic } = await loadMergePatch();
    const baseline = defaultConfig();
    // Patch JUST the enabled flag — threshold should survive.
    const merged = mergePatchPublic(
      { ...baseline, voice: { ...baseline.voice, vadThreshold: 0.7 } },
      { voice: { enabled: true } },
    );
    expect(merged.voice.enabled).toBe(true);
    expect(merged.voice.vadThreshold).toBe(0.7);
  });
});

// mergePatch is module-private to config.ts — we use applyPatchInMemory
// (exported) which has the identical merge logic.
async function loadMergePatch(): Promise<{
  readonly mergePatchPublic: (
    current: ReturnType<typeof defaultConfig>,
    patch: Parameters<typeof ApplyPatchInMemory>[1],
  ) => ReturnType<typeof defaultConfig>;
}> {
  const { applyPatchInMemory } = await import(
    '../../src/utils/config-context.js'
  );
  return { mergePatchPublic: applyPatchInMemory };
}
