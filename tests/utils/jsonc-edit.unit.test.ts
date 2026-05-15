import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  editJsoncFile,
  JsoncParseError,
  modifyJsonc,
  parseJsoncObject,
  stripOwnEntriesByMarker,
} from '../../src/utils/jsonc-edit.js';

describe('modifyJsonc — comment/format preservation', () => {
  it('keeps comments + untouched keys when changing a value', () => {
    const src = `{
  // user's hand-tuned pick
  "modelMode": "opus",
  "theme": { "name": "violet" } // keep me
}`;
    const out = modifyJsonc(src, ['modelMode'], 'mixed');
    expect(out).toContain("// user's hand-tuned pick");
    expect(out).toContain('// keep me');
    expect(out).toContain('"modelMode": "mixed"');
    expect(out).toContain('"theme"');
  });

  it('value: undefined deletes the path', () => {
    const out = modifyJsonc('{ "a": 1, "b": 2 }', ['a'], undefined);
    expect(parseJsoncObject(out)).toEqual({ b: 2 });
  });

  it('no-op edit returns the original string by identity of content', () => {
    const src = '{\n  "a": 1\n}\n';
    expect(modifyJsonc(src, ['a'], 1)).toBe(src);
  });

  it('throws JsoncParseError on a corrupt file before editing', () => {
    expect(() => modifyJsonc('{ not json', ['a'], 1, { file: 'x.json' })).toThrow(
      JsoncParseError,
    );
  });

  it('validate:false skips the parse gate (caller pre-validated)', () => {
    // Corrupt input would throw with validation; disabled, modify still runs.
    expect(() =>
      modifyJsonc('{ "a": 1 ', ['a'], 2, { validate: false }),
    ).not.toThrow();
  });
});

describe('parseJsoncObject', () => {
  it('accepts comments + trailing commas', () => {
    expect(
      parseJsoncObject('{ /* c */ "a": 1, "b": [1,2,], }'),
    ).toEqual({ a: 1, b: [1, 2] });
  });

  it('rejects a non-object root', () => {
    expect(() => parseJsoncObject('[1,2,3]')).toThrow(JsoncParseError);
    expect(() => parseJsoncObject('"str"')).toThrow(/root value must be an object/);
  });
});

describe('stripOwnEntriesByMarker', () => {
  it('drops entries whose serialization contains the marker, keeps user ones', () => {
    const entries = [
      { hooks: [{ command: 'curl ... $SYMPHONY_HOOK_PORT ... || true' }] },
      { hooks: [{ command: 'my-own-user-hook.sh' }] },
      { matcher: 'X', hooks: [{ command: 'nested $SYMPHONY_HOOK_PORT' }] },
    ];
    const kept = stripOwnEntriesByMarker(entries, 'SYMPHONY_HOOK_PORT');
    expect(kept).toEqual([{ hooks: [{ command: 'my-own-user-hook.sh' }] }]);
  });

  it('returns a fresh array (no mutation of input)', () => {
    const input = [{ a: 1 }];
    const out = stripOwnEntriesByMarker(input, 'zzz');
    expect(out).not.toBe(input);
    expect(out).toEqual(input);
  });
});

describe('editJsoncFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'symphony-jsonc-'));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('creates a missing file from {} and applies edits', async () => {
    const f = path.join(dir, 'settings.local.json');
    await editJsoncFile(f, [{ path: ['hooks', 'Stop'], value: ['x'] }]);
    expect(parseJsoncObject(await fsp.readFile(f, 'utf8'))).toEqual({
      hooks: { Stop: ['x'] },
    });
  });

  it('preserves comments in an existing file across edits', async () => {
    const f = path.join(dir, 'c.json');
    await fsp.writeFile(f, '{\n  // keep\n  "a": 1\n}\n');
    await editJsoncFile(f, [
      { path: ['a'], value: 2 },
      { path: ['b'], value: true },
    ]);
    const text = await fsp.readFile(f, 'utf8');
    expect(text).toContain('// keep');
    expect(parseJsoncObject(text)).toEqual({ a: 2, b: true });
    expect(text.endsWith('\n')).toBe(true);
  });

  it('rejects editing a corrupt existing file (atomic — original intact)', async () => {
    const f = path.join(dir, 'bad.json');
    await fsp.writeFile(f, '{ broken');
    await expect(
      editJsoncFile(f, [{ path: ['a'], value: 1 }]),
    ).rejects.toBeInstanceOf(JsoncParseError);
    expect(await fsp.readFile(f, 'utf8')).toBe('{ broken');
  });
});
