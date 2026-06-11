/**
 * Phase 9D — the two browser skeleton plugins (browserbase + chrome-devtools-mcp)
 * are docs + non-functional skeletons. There is ZERO new `src/` code; their
 * whole point is that the EXISTING capability envelope enforces them purely
 * from the manifest's `capabilityFlags`.
 *
 * This test parses the REAL example manifests and runs their translated flags
 * through the REAL `CapabilityEvaluator` (the same instance the dispatch shim
 * uses), proving:
 *   - browserbase → Tier-2 floor (denied at Tier 1, allowed at Tier 2/3),
 *   - chrome-devtools-mcp → EXACT Tier 3 + act-only + away-denied +
 *     automation-denied,
 * with no enforcement code shipped by either plugin.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parsePluginManifest } from '../../src/plugins/manifest.js';
import { translateCapabilityFlags } from '../../src/plugins/permissions.js';
import { CapabilityEvaluator } from '../../src/orchestrator/capabilities.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.join(here, '..', '..', 'packages', 'examples');

function loadManifest(dir: string): ReturnType<typeof parsePluginManifest> {
  const raw = readFileSync(path.join(EXAMPLES, dir, 'plugin.json'), 'utf8');
  return parsePluginManifest(JSON.parse(raw));
}

function ctx(over: Partial<DispatchContext>): DispatchContext {
  return { mode: 'act', tier: 3, awayMode: false, automationContext: false, ...over };
}

describe('9D — browserbase manifest + Tier-2 envelope', () => {
  const manifest = loadManifest('browserbase');

  it('parses with the expected browser-plugin shape (not an issue source)', () => {
    expect(manifest.id).toBe('browserbase-example');
    expect(manifest.toolScope).toBe('act');
    expect(manifest.provides).toBeUndefined();
    expect([...manifest.capabilityFlags].sort()).toEqual(
      ['external-visible', 'requires:network-egress', 'requires:secrets-read'].sort(),
    );
    expect([...manifest.permissions].sort()).toEqual(
      ['net:*.browserbase.com', 'secrets:read'].sort(),
    );
  });

  const flags = translateCapabilityFlags(manifest.capabilityFlags);

  it('translates to the dash-form host flags', () => {
    expect([...flags].sort()).toEqual(
      [
        'external-visible',
        'requires-network-egress-uncontrolled',
        'requires-secrets-read',
      ].sort(),
    );
  });

  it('is DENIED at Tier 1', () => {
    const evaluator = new CapabilityEvaluator();
    const d = evaluator.evaluate(flags, ctx({ tier: 1 }), 'browserbase-example__act');
    expect(d.allow).toBe(false);
    // Tier-1 denial comes from the first Tier-≥2 flag checked.
    expect(d.reason).toMatch(/tier 2/i);
  });

  it('is ALLOWED at Tier 2 (with a first-use secrets notice) and Tier 3', () => {
    const evaluator = new CapabilityEvaluator();
    const t2 = evaluator.evaluate(flags, ctx({ tier: 2 }), 'browserbase-example__act');
    expect(t2.allow).toBe(true);
    expect(t2.notice).toEqual({
      kind: 'first-use',
      tool: 'browserbase-example__act',
      flag: 'requires-secrets-read',
    });
    const t3 = evaluator.evaluate(flags, ctx({ tier: 3 }), 'browserbase-example__act');
    expect(t3.allow).toBe(true);
  });

  it('does NOT require act mode (works while planning) — that is a scope concern, not capability', () => {
    const evaluator = new CapabilityEvaluator();
    const d = evaluator.evaluate(flags, ctx({ tier: 2, mode: 'plan' }), 'bb');
    expect(d.allow).toBe(true);
  });
});

describe('9D — chrome-devtools-mcp manifest + EXACT-Tier-3 envelope', () => {
  const manifest = loadManifest('chrome-devtools-mcp');

  it('parses with host-browser-control + irreversible, no permissions, no provider', () => {
    expect(manifest.id).toBe('chrome-devtools-mcp-example');
    expect(manifest.toolScope).toBe('act');
    expect(manifest.provides).toBeUndefined();
    expect(manifest.permissions).toEqual([]);
    expect([...manifest.capabilityFlags].sort()).toEqual(
      ['irreversible', 'requires:host-browser-control'].sort(),
    );
  });

  const flags = translateCapabilityFlags(manifest.capabilityFlags);

  it('translates to the dash-form host flags', () => {
    expect([...flags].sort()).toEqual(
      ['irreversible', 'requires-host-browser-control'].sort(),
    );
  });

  it('is ALLOWED only at Tier 3, act mode, present, non-automation', () => {
    const evaluator = new CapabilityEvaluator();
    expect(evaluator.evaluate(flags, ctx({}), 'cdp').allow).toBe(true);
  });

  it('is DENIED below Tier 3 (exact, not a floor)', () => {
    const evaluator = new CapabilityEvaluator();
    const t2 = evaluator.evaluate(flags, ctx({ tier: 2 }), 'cdp');
    expect(t2.allow).toBe(false);
    expect(t2.reason).toMatch(/tier 3/i);
    expect(evaluator.evaluate(flags, ctx({ tier: 1 }), 'cdp').allow).toBe(false);
  });

  it('is DENIED in plan mode even at Tier 3', () => {
    const evaluator = new CapabilityEvaluator();
    const d = evaluator.evaluate(flags, ctx({ mode: 'plan' }), 'cdp');
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/act mode/i);
  });

  it('is DENIED in Away Mode even at Tier 3 + act', () => {
    const evaluator = new CapabilityEvaluator();
    const d = evaluator.evaluate(flags, ctx({ awayMode: true }), 'cdp');
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/away mode/i);
  });

  it('is DENIED from an automation context even at Tier 3 + act', () => {
    const evaluator = new CapabilityEvaluator();
    const d = evaluator.evaluate(flags, ctx({ automationContext: true }), 'cdp');
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/automation/i);
  });
});
