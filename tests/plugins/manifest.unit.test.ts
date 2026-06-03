import { describe, expect, it } from 'vitest';

import {
  assertPluginApiCompatible,
  parsePluginManifest,
  PluginApiMismatchError,
  PluginManifestError,
  satisfiesPluginApi,
  type PluginManifest,
} from '../../src/plugins/manifest.js';

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'notion-tasks',
    name: 'Notion Tasks',
    version: '0.3.1',
    author: 'you@example.com',
    description: 'Pull tasks from Notion.',
    entrypoint: { command: 'node', args: ['server.js'] },
    ...overrides,
  };
}

describe('parsePluginManifest', () => {
  it('parses a minimal valid manifest with defaults', () => {
    const m: PluginManifest = parsePluginManifest(baseManifest());
    expect(m.id).toBe('notion-tasks');
    expect(m.name).toBe('Notion Tasks');
    expect(m.entrypoint).toEqual({ command: 'node', args: ['server.js'] });
    // Defaults
    expect(m.permissions).toEqual([]);
    expect(m.capabilityFlags).toEqual([]);
    expect(m.events).toEqual([]);
    expect(m.toolScope).toBe('act');
  });

  it('parses permissions, capability flags, events', () => {
    const m = parsePluginManifest(
      baseManifest({
        permissions: ['task:read', 'task:write', 'net:api.notion.com'],
        capabilityFlags: ['requires:network-egress', 'requires:secrets-read'],
        events: ['onTaskCompleted', 'onWorkerSpawned'],
        toolScope: 'both',
      }),
    );
    expect(m.permissions).toEqual(['task:read', 'task:write', 'net:api.notion.com']);
    expect(m.capabilityFlags).toEqual(['requires:network-egress', 'requires:secrets-read']);
    expect(m.events).toEqual(['onTaskCompleted', 'onWorkerSpawned']);
    expect(m.toolScope).toBe('both');
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() => parsePluginManifest(baseManifest({ rogue: true }))).toThrow(
      PluginManifestError,
    );
  });

  it('rejects an unsafe id (traversal / uppercase / separators)', () => {
    expect(() => parsePluginManifest(baseManifest({ id: '../evil' }))).toThrow(
      PluginManifestError,
    );
    expect(() => parsePluginManifest(baseManifest({ id: 'Notion' }))).toThrow(
      PluginManifestError,
    );
    expect(() => parsePluginManifest(baseManifest({ id: '.hidden' }))).toThrow(
      PluginManifestError,
    );
  });

  it('rejects an unknown permission string', () => {
    expect(() =>
      parsePluginManifest(baseManifest({ permissions: ['filesystem:obliterate'] })),
    ).toThrow(PluginManifestError);
  });

  it('rejects a malformed net: host', () => {
    expect(() =>
      parsePluginManifest(baseManifest({ permissions: ['net:not a host'] })),
    ).toThrow(PluginManifestError);
  });

  it('rejects writes-source as a manifest capability flag', () => {
    // writes-source is the Maestro-delegator fence — not a manifest flag.
    expect(() =>
      parsePluginManifest(baseManifest({ capabilityFlags: ['writes-source'] })),
    ).toThrow(PluginManifestError);
  });

  it('rejects a missing required field', () => {
    const noEntry = baseManifest();
    delete noEntry['entrypoint'];
    expect(() => parsePluginManifest(noEntry)).toThrow(PluginManifestError);
  });

  it('rejects a wrong schemaVersion', () => {
    expect(() => parsePluginManifest(baseManifest({ schemaVersion: 2 }))).toThrow(
      PluginManifestError,
    );
  });

  it('de-duplicates permissions while preserving order', () => {
    const m = parsePluginManifest(
      baseManifest({ permissions: ['task:read', 'task:read', 'project:read'] }),
    );
    expect(m.permissions).toEqual(['task:read', 'project:read']);
  });
});

describe('satisfiesPluginApi', () => {
  it('caret matches same major and >= version', () => {
    expect(satisfiesPluginApi('^1.0.0', '1.0.0')).toBe(true);
    expect(satisfiesPluginApi('^1.0.0', '1.4.2')).toBe(true);
    expect(satisfiesPluginApi('^1.2.0', '1.1.0')).toBe(false);
    expect(satisfiesPluginApi('^2.0.0', '1.9.9')).toBe(false);
  });

  it('exact requires equality', () => {
    expect(satisfiesPluginApi('1.0.0', '1.0.0')).toBe(true);
    expect(satisfiesPluginApi('1.0.0', '1.0.1')).toBe(false);
  });

  it('>= range', () => {
    expect(satisfiesPluginApi('>=1.0.0', '1.5.0')).toBe(true);
    expect(satisfiesPluginApi('>=2.0.0', '1.5.0')).toBe(false);
  });

  it('major-only and wildcard', () => {
    expect(satisfiesPluginApi('1', '1.9.9')).toBe(true);
    expect(satisfiesPluginApi('1.x', '1.0.0')).toBe(true);
    expect(satisfiesPluginApi('2', '1.0.0')).toBe(false);
    expect(satisfiesPluginApi('*', '1.0.0')).toBe(true);
  });

  it('fails closed on garbage', () => {
    expect(satisfiesPluginApi('not-a-version', '1.0.0')).toBe(false);
  });
});

describe('assertPluginApiCompatible', () => {
  it('no-op when requiresPluginApi absent', () => {
    expect(() => assertPluginApiCompatible(parsePluginManifest(baseManifest()))).not.toThrow();
  });

  it('passes for a compatible range', () => {
    const m = parsePluginManifest(baseManifest({ requiresPluginApi: '^1.0.0' }));
    expect(() => assertPluginApiCompatible(m)).not.toThrow();
  });

  it('throws PluginApiMismatchError for an incompatible range', () => {
    const m = parsePluginManifest(baseManifest({ requiresPluginApi: '^2.0.0' }));
    expect(() => assertPluginApiCompatible(m)).toThrow(PluginApiMismatchError);
  });
});
