import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertSafePluginId,
  pluginDir,
  pluginManifestPath,
  pluginsDir,
  PluginIdError,
  SYMPHONY_PLUGINS_DIR_ENV,
} from '../../src/plugins/paths.js';

const original = process.env[SYMPHONY_PLUGINS_DIR_ENV];
afterEach(() => {
  if (original === undefined) delete process.env[SYMPHONY_PLUGINS_DIR_ENV];
  else process.env[SYMPHONY_PLUGINS_DIR_ENV] = original;
});

describe('assertSafePluginId', () => {
  it('accepts a lowercase kebab/underscore id', () => {
    expect(assertSafePluginId('notion-tasks')).toBe('notion-tasks');
    expect(assertSafePluginId('a_b_c')).toBe('a_b_c');
    expect(assertSafePluginId('plugin1')).toBe('plugin1');
  });

  it('rejects separators, traversal, leading dot, uppercase, NUL', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', '.hidden', 'Notion', 'a b', '', `a${String.fromCharCode(0)}b`]) {
      expect(() => assertSafePluginId(bad)).toThrow(PluginIdError);
    }
  });

  it('rejects over-length ids', () => {
    expect(() => assertSafePluginId('a'.repeat(65))).toThrow(PluginIdError);
  });

  it('rejects "__" (the tool-namespace separator) inside an id', () => {
    expect(() => assertSafePluginId('a__b')).toThrow(PluginIdError);
    // single underscore is fine
    expect(assertSafePluginId('a_b')).toBe('a_b');
  });
});

describe('plugin path helpers', () => {
  it('honors the SYMPHONY_PLUGINS_DIR env override', () => {
    process.env[SYMPHONY_PLUGINS_DIR_ENV] = path.join('/tmp', 'sym-plugins');
    expect(pluginsDir()).toBe(path.resolve('/tmp', 'sym-plugins'));
    expect(pluginDir('foo')).toBe(path.resolve('/tmp', 'sym-plugins', 'foo'));
    expect(pluginManifestPath('foo')).toBe(
      path.resolve('/tmp', 'sym-plugins', 'foo', 'plugin.json'),
    );
  });

  it('validates id before joining a path', () => {
    process.env[SYMPHONY_PLUGINS_DIR_ENV] = path.join('/tmp', 'sym-plugins');
    expect(() => pluginDir('../escape')).toThrow(PluginIdError);
  });
});
