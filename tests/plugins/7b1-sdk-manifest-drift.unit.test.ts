/**
 * Phase 7B.1 — drift lock between the host-side manifest schema
 * (`src/plugins/manifest.ts` + `permissions.ts` + `paths.ts`) and the
 * SDK's independent re-implementation
 * (`packages/plugin-sdk/src/manifest.ts`).
 *
 * The SDK is a separate package and cannot import the app's internals, so
 * the schema is duplicated. This test asserts BOTH validators accept and
 * reject an identical fixture matrix, and that the advertised API version
 * matches. If the two schemas diverge, CI fails here.
 */
import { describe, expect, it } from 'vitest';

import {
  parsePluginManifest,
  PLUGIN_API_VERSION as HOST_API_VERSION,
} from '../../src/plugins/manifest.js';
import {
  validateManifest as sdkValidate,
  PLUGIN_API_VERSION as SDK_API_VERSION,
  MANIFEST_CAPABILITY_FLAGS as SDK_FLAGS,
  PLUGIN_EVENTS as SDK_EVENTS,
  FIXED_PERMISSIONS as SDK_PERMS,
} from '../../packages/plugin-sdk/src/manifest.js';
import { MANIFEST_CAPABILITY_FLAGS, PLUGIN_EVENTS } from '../../src/plugins/manifest.js';
import { FIXED_PERMISSIONS } from '../../src/plugins/permissions.js';

const base = {
  schemaVersion: 1,
  id: 'my-plugin',
  name: 'My Plugin',
  version: '0.1.0',
  author: 'someone',
  description: 'does things',
  entrypoint: { command: 'node', args: ['index.js'] },
};

const VALID: ReadonlyArray<Record<string, unknown>> = [
  { ...base },
  { ...base, permissions: ['task:read', 'net:api.notion.com'] },
  { ...base, capabilityFlags: ['requires:secrets-read', 'external-visible'] },
  { ...base, events: ['onTaskCompleted', 'onWorkerCompleted'] },
  { ...base, requiresPluginApi: '^1.0.0', toolScope: 'both' },
  { ...base, permissions: ['net:*.example.com'] },
  { ...base, permissions: ['net:api.example.com:8443'] },
  // host regex is case-insensitive (`/i`) on both sides — accepted.
  { ...base, permissions: ['net:API.example.com'] },
  { ...base, homepage: 'https://example.com', configSchema: { type: 'object' } },
  // Phase 9A — issue-source provider declaration.
  { ...base, provides: { issueSource: { source: 'github' } } },
  { ...base, provides: { issueSource: { source: 'my_tracker' } } },
  { ...base, provides: {} },
  // Phase 9B — optional host-side poll cadence on the issue source.
  { ...base, provides: { issueSource: { source: 'obsidian', pollIntervalMs: 30000 } } },
  { ...base, provides: { issueSource: { source: 'obsidian', pollIntervalMs: 5000 } } },
  { ...base, provides: { issueSource: { source: 'obsidian', pollIntervalMs: 86400000 } } },
  // Phase 9C.1 — remaining connectors repackaged as plugins (pull-only).
  { ...base, provides: { issueSource: { source: 'linear' } } },
  { ...base, provides: { issueSource: { source: 'jira' } } },
  // Phase 9C.2 — the Git-forge siblings.
  { ...base, provides: { issueSource: { source: 'gitlab' } } },
  { ...base, provides: { issueSource: { source: 'forgejo' } } },
  // Phase 9C.3 — the divergent-writeback pair.
  { ...base, provides: { issueSource: { source: 'plain' } } },
  { ...base, provides: { issueSource: { source: 'sentry' } } },
];

const INVALID: ReadonlyArray<{ label: string; input: Record<string, unknown> }> = [
  { label: 'wrong schemaVersion', input: { ...base, schemaVersion: 2 } },
  { label: 'unknown top-level key', input: { ...base, bogus: true } },
  { label: 'unsafe id (traversal)', input: { ...base, id: '../evil' } },
  { label: 'id with __', input: { ...base, id: 'a__b' } },
  { label: 'uppercase id', input: { ...base, id: 'MyPlugin' } },
  { label: 'unknown permission', input: { ...base, permissions: ['files:read'] } },
  { label: 'bad net host', input: { ...base, permissions: ['net:not a host'] } },
  { label: 'wildcard mid-label net host', input: { ...base, permissions: ['net:a.*.example.com'] } },
  { label: 'unknown capability flag', input: { ...base, capabilityFlags: ['writes-source'] } },
  { label: 'unknown event', input: { ...base, events: ['onWhatever'] } },
  { label: 'empty command', input: { ...base, entrypoint: { command: '', args: [] } } },
  { label: 'bad homepage url', input: { ...base, homepage: 'not-a-url' } },
  { label: 'configSchema not an object', input: { ...base, configSchema: 'nope' } },
  { label: 'empty requiresPluginApi', input: { ...base, requiresPluginApi: '' } },
  { label: 'missing name', input: { schemaVersion: 1, id: 'x', version: '1', author: 'a', description: 'd', entrypoint: { command: 'node' } } },
  // Phase 9A — issue-source provider validation.
  { label: 'issueSource bad source (uppercase)', input: { ...base, provides: { issueSource: { source: 'GitHub' } } } },
  { label: 'issueSource bad source (leading digit)', input: { ...base, provides: { issueSource: { source: '1tracker' } } } },
  { label: 'issueSource missing source', input: { ...base, provides: { issueSource: {} } } },
  { label: 'provides unknown key', input: { ...base, provides: { bogusSource: { source: 'x' } } } },
  { label: 'issueSource unknown key', input: { ...base, provides: { issueSource: { source: 'github', extra: 1 } } } },
  // Phase 9B — pollIntervalMs bounds + type.
  { label: 'pollIntervalMs below floor', input: { ...base, provides: { issueSource: { source: 'obsidian', pollIntervalMs: 4999 } } } },
  { label: 'pollIntervalMs above ceiling', input: { ...base, provides: { issueSource: { source: 'obsidian', pollIntervalMs: 86400001 } } } },
  { label: 'pollIntervalMs non-integer', input: { ...base, provides: { issueSource: { source: 'obsidian', pollIntervalMs: 30000.5 } } } },
  { label: 'pollIntervalMs not a number', input: { ...base, provides: { issueSource: { source: 'obsidian', pollIntervalMs: '30000' } } } },
];

describe('7B.1 SDK ↔ host manifest drift lock', () => {
  it('advertises the same PLUGIN_API_VERSION', () => {
    expect(SDK_API_VERSION).toBe(HOST_API_VERSION);
  });

  it('shares the same capability-flag, event, and permission vocabularies', () => {
    expect([...SDK_FLAGS]).toEqual([...MANIFEST_CAPABILITY_FLAGS]);
    expect([...SDK_EVENTS]).toEqual([...PLUGIN_EVENTS]);
    expect([...SDK_PERMS]).toEqual([...FIXED_PERMISSIONS]);
  });

  it.each(VALID.map((input, i) => [i, input] as const))(
    'both ACCEPT valid manifest #%i',
    (_i, input) => {
      const host = parsePluginManifest(input);
      const sdk = sdkValidate(input);
      // Same canonical normalized result.
      expect(sdk).toEqual(host);
    },
  );

  it.each(INVALID.map((c) => [c.label, c.input] as const))(
    'both REJECT invalid manifest: %s',
    (_label, input) => {
      expect(() => parsePluginManifest(input)).toThrow();
      expect(() => sdkValidate(input)).toThrow();
    },
  );
});
