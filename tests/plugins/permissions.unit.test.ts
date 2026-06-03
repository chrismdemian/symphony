import { describe, expect, it } from 'vitest';

import {
  PluginPermissionError,
  translateCapabilityFlags,
  validatePermission,
  validatePermissions,
} from '../../src/plugins/permissions.js';

describe('validatePermission', () => {
  it('accepts fixed permissions', () => {
    expect(validatePermission('worker:spawn')).toBe('worker:spawn');
    expect(validatePermission('task:read')).toBe('task:read');
    expect(validatePermission('voice:transcript')).toBe('voice:transcript');
  });

  it('accepts net:<host> including wildcard and port', () => {
    expect(validatePermission('net:api.notion.com')).toBe('net:api.notion.com');
    expect(validatePermission('net:*.example.com')).toBe('net:*.example.com');
    expect(validatePermission('net:localhost:8080')).toBe('net:localhost:8080');
  });

  it('rejects unknown fixed permission', () => {
    expect(() => validatePermission('worker:obliterate')).toThrow(PluginPermissionError);
  });

  it('rejects malformed net host', () => {
    expect(() => validatePermission('net:has space.com')).toThrow(PluginPermissionError);
    expect(() => validatePermission('net:')).toThrow(PluginPermissionError);
  });
});

describe('validatePermissions', () => {
  it('de-dupes preserving order', () => {
    expect(validatePermissions(['task:read', 'task:read', 'project:read'])).toEqual([
      'task:read',
      'project:read',
    ]);
  });

  it('throws on the first invalid entry', () => {
    expect(() => validatePermissions(['task:read', 'bogus'])).toThrow(PluginPermissionError);
  });
});

describe('translateCapabilityFlags', () => {
  it('maps manifest colon flags to Symphony dash flags', () => {
    expect(
      translateCapabilityFlags([
        'requires:host-browser-control',
        'requires:secrets-read',
        'requires:network-egress',
        'external-visible',
        'irreversible',
      ]),
    ).toEqual([
      'requires-host-browser-control',
      'requires-secrets-read',
      'requires-network-egress-uncontrolled',
      'external-visible',
      'irreversible',
    ]);
  });

  it('drops requires:filesystem-write (no tier floor) but keeps others', () => {
    expect(
      translateCapabilityFlags(['requires:filesystem-write', 'irreversible']),
    ).toEqual(['irreversible']);
  });

  it('collapses duplicates', () => {
    expect(
      translateCapabilityFlags(['irreversible', 'irreversible']),
    ).toEqual(['irreversible']);
  });

  it('empty in, empty out', () => {
    expect(translateCapabilityFlags([])).toEqual([]);
  });
});
