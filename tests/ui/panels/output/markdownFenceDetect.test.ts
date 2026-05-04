import { describe, it, expect } from 'vitest';
import { detectMarkdownFences } from '../../../../src/ui/panels/output/markdownFenceDetect.js';

describe('detectMarkdownFences', () => {
  it('returns single text segment when no fences', () => {
    const r = detectMarkdownFences('plain prose with no fences');
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toEqual({ kind: 'text', value: 'plain prose with no fences' });
  });

  it('detects a single ts fence', () => {
    const text = 'Hello\n```ts\nconst x: number = 1;\n```\nworld';
    const r = detectMarkdownFences(text);
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]).toEqual({ kind: 'text', value: 'Hello\n' });
    expect(r.segments[1]).toEqual({
      kind: 'code',
      lang: 'ts',
      source: 'const x: number = 1;',
    });
    expect(r.segments[2]).toEqual({ kind: 'text', value: '\nworld' });
  });

  it('detects a diff fence as separate kind', () => {
    const text = '```diff\n+added\n-removed\n```';
    const r = detectMarkdownFences(text);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toEqual({
      kind: 'diff',
      source: '+added\n-removed',
    });
  });

  it('PASSES THROUGH json-render fences as plain text', () => {
    const text = '```json-render\n{"version":"1"}\n```';
    const r = detectMarkdownFences(text);
    // The reserved tag is upstream's responsibility (jsonRenderDetect).
    // detectMarkdownFences must NOT consume it.
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]?.kind).toBe('text');
    expect((r.segments[0] as { value: string }).value).toContain('```json-render');
  });

  it('handles unclosed fence gracefully (treats as text)', () => {
    const text = '```ts\nconst x = 1;\nNo closing delim';
    const r = detectMarkdownFences(text);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]?.kind).toBe('text');
  });

  it('drops whitespace-only segments between fences', () => {
    const text = '```ts\nfoo\n```\n\n\n```py\nbar\n```';
    const r = detectMarkdownFences(text);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]?.kind).toBe('code');
    expect(r.segments[1]?.kind).toBe('code');
  });

  it('CRLF-aware regex matches Windows line endings', () => {
    const text = '```ts\r\nfoo\r\n```';
    const r = detectMarkdownFences(text);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toEqual({ kind: 'code', lang: 'ts', source: 'foo' });
  });

  it('untagged fence is code with empty lang', () => {
    const text = '```\nplain\n```';
    const r = detectMarkdownFences(text);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toEqual({ kind: 'code', lang: '', source: 'plain' });
  });

  it('treats `patch` tag as diff', () => {
    const r = detectMarkdownFences('```patch\n+a\n-b\n```');
    expect(r.segments[0]?.kind).toBe('diff');
  });

  it('multiple fences in document order', () => {
    const text = '```ts\na\n```\n\n```py\nb\n```\n\n```diff\n+c\n```';
    const r = detectMarkdownFences(text);
    const kinds = r.segments.map((s) => s.kind);
    expect(kinds).toEqual(['code', 'code', 'diff']);
  });
});
