import { describe, it, expect } from 'vitest';
import { ndjsonLines, DEFAULT_MAX_LINE_BYTES } from '../../src/workers/ndjson.js';
import type { NdjsonLine } from '../../src/workers/ndjson.js';

async function collect(source: AsyncIterable<string | Buffer>, maxLineBytes?: number): Promise<NdjsonLine[]> {
  const out: NdjsonLine[] = [];
  for await (const line of ndjsonLines(source, maxLineBytes ? { maxLineBytes } : {})) {
    out.push(line);
  }
  return out;
}

async function* fromChunks<T>(...chunks: T[]): AsyncIterable<T> {
  for (const c of chunks) yield c;
}

describe('ndjsonLines', () => {
  it('splits simple LF-terminated lines', async () => {
    const lines = await collect(fromChunks('one\ntwo\nthree\n'));
    expect(lines).toEqual([
      { kind: 'line', value: 'one' },
      { kind: 'line', value: 'two' },
      { kind: 'line', value: 'three' },
    ]);
  });

  it('handles chunks that split a line in the middle', async () => {
    const lines = await collect(fromChunks('hel', 'lo\nwor', 'ld\n'));
    expect(lines).toEqual([
      { kind: 'line', value: 'hello' },
      { kind: 'line', value: 'world' },
    ]);
  });

  it('strips trailing CR (Windows line endings)', async () => {
    const lines = await collect(fromChunks('alpha\r\nbeta\r\n'));
    expect(lines).toEqual([
      { kind: 'line', value: 'alpha' },
      { kind: 'line', value: 'beta' },
    ]);
  });

  it('skips blank lines', async () => {
    const lines = await collect(fromChunks('a\n\n\nb\n'));
    expect(lines).toEqual([
      { kind: 'line', value: 'a' },
      { kind: 'line', value: 'b' },
    ]);
  });

  it('flushes trailing data without a final newline', async () => {
    const lines = await collect(fromChunks('unterminated'));
    expect(lines).toEqual([{ kind: 'line', value: 'unterminated' }]);
  });

  it('handles Buffer input with UTF-8 multibyte split across chunks', async () => {
    // '→' is 0xE2 0x86 0x92 — split across two chunks.
    const full = Buffer.from('a→b\n', 'utf8');
    const first = full.subarray(0, 2); // 'a' + 0xE2
    const second = full.subarray(2); // 0x86 0x92 'b' \n
    const lines = await collect(fromChunks<Buffer>(first, second));
    expect(lines).toEqual([{ kind: 'line', value: 'a→b' }]);
  });

  it('emits over_cap when a single line exceeds maxLineBytes and recovers', async () => {
    const maxLineBytes = 16;
    const huge = 'x'.repeat(64) + '\nshort\n';
    const lines = await collect(fromChunks(huge), maxLineBytes);
    expect(lines[0]?.kind).toBe('over_cap');
    expect(lines[1]).toEqual({ kind: 'line', value: 'short' });
  });

  it('default max is 10 MB', () => {
    expect(DEFAULT_MAX_LINE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('ignores BOM at start of input', async () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('first\nsecond\n', 'utf8')]);
    const lines = await collect(fromChunks<Buffer>(withBom));
    expect(lines).toEqual([
      { kind: 'line', value: 'first' },
      { kind: 'line', value: 'second' },
    ]);
  });

  it('yields nothing for empty input', async () => {
    const lines = await collect(fromChunks());
    expect(lines).toEqual([]);
  });
});
