import { describe, it, expect } from 'vitest';
import { detectJsonRenderBlocks } from '../../../../src/ui/panels/output/jsonRenderDetect.js';

describe('detectJsonRenderBlocks', () => {
  it('returns single text segment for empty string', () => {
    const { segments } = detectJsonRenderBlocks('');
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ kind: 'text', value: '' });
  });

  it('returns single text segment for plain text without fences', () => {
    const text = 'hello world\nfoo bar baz';
    const { segments } = detectJsonRenderBlocks(text);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ kind: 'text', value: text });
  });

  it('parses a single valid fence with text on both sides', () => {
    const text = [
      'narrative before',
      '```json-render',
      '{"root":"a","elements":{"a":{"type":"Text","props":{"text":"hi"}}}}',
      '```',
      'narrative after',
    ].join('\n');
    const { segments } = detectJsonRenderBlocks(text);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ kind: 'text', value: 'narrative before\n' });
    expect(segments[1]?.kind).toBe('spec');
    if (segments[1]?.kind === 'spec') {
      expect(segments[1].spec).toEqual({
        root: 'a',
        elements: { a: { type: 'Text', props: { text: 'hi' } } },
      });
    }
    expect(segments[2]).toEqual({ kind: 'text', value: '\nnarrative after' });
  });

  it('handles multiple fences with text segments between them', () => {
    const text = [
      'a',
      '```json-render',
      '{"root":"x","elements":{"x":{"type":"Text","props":{"text":"1"}}}}',
      '```',
      'b',
      '```json-render',
      '{"root":"y","elements":{"y":{"type":"Text","props":{"text":"2"}}}}',
      '```',
      'c',
    ].join('\n');
    const { segments } = detectJsonRenderBlocks(text);
    const kinds = segments.map((s) => s.kind);
    expect(kinds).toEqual(['text', 'spec', 'text', 'spec', 'text']);
  });

  it('reports invalid JSON as an invalid segment with the parse reason', () => {
    const text = [
      'before',
      '```json-render',
      '{not valid json',
      '```',
      'after',
    ].join('\n');
    const { segments } = detectJsonRenderBlocks(text);
    expect(segments).toHaveLength(3);
    expect(segments[1]?.kind).toBe('invalid');
    if (segments[1]?.kind === 'invalid') {
      expect(segments[1].raw).toBe('{not valid json');
      expect(segments[1].reason.length).toBeGreaterThan(0);
    }
  });

  it('treats incomplete fence (no closing) as plain text', () => {
    const text = 'before\n```json-render\n{"root":"a"\nstill no closing';
    const { segments } = detectJsonRenderBlocks(text);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ kind: 'text', value: text });
  });

  it('matches CRLF line endings', () => {
    const inner = '{"root":"x","elements":{"x":{"type":"Text","props":{"text":"crlf"}}}}';
    const text = `before\r\n\`\`\`json-render\r\n${inner}\r\n\`\`\`\r\nafter`;
    const { segments } = detectJsonRenderBlocks(text);
    const specSeg = segments.find((s) => s.kind === 'spec');
    expect(specSeg?.kind).toBe('spec');
    if (specSeg?.kind === 'spec') {
      expect(specSeg.spec).toEqual({
        root: 'x',
        elements: { x: { type: 'Text', props: { text: 'crlf' } } },
      });
    }
  });

  it('drops whitespace-only segments between back-to-back fences', () => {
    const text = [
      '```json-render',
      '{"root":"a","elements":{"a":{"type":"Text","props":{"text":"1"}}}}',
      '```',
      '',
      '```json-render',
      '{"root":"b","elements":{"b":{"type":"Text","props":{"text":"2"}}}}',
      '```',
    ].join('\n');
    const { segments } = detectJsonRenderBlocks(text);
    const kinds = segments.map((s) => s.kind);
    // No text segment between the two specs (the only thing between them
    // is the fence-trailing/-leading whitespace that the detector drops).
    expect(kinds).toEqual(['spec', 'spec']);
  });

  it('treats a fence with whitespace-only body as invalid (JSON.parse rejects empty input)', () => {
    const text = ['before', '```json-render', '   ', '```', 'after'].join('\n');
    const { segments } = detectJsonRenderBlocks(text);
    const invalid = segments.find((s) => s.kind === 'invalid');
    expect(invalid?.kind).toBe('invalid');
  });

  it('preserves non-whitespace text segments at start and end', () => {
    const text = [
      'leading',
      '```json-render',
      '{"root":"a","elements":{"a":{"type":"Text","props":{"text":"x"}}}}',
      '```',
      'trailing',
    ].join('\n');
    const { segments } = detectJsonRenderBlocks(text);
    expect(segments[0]).toEqual({ kind: 'text', value: 'leading\n' });
    expect(segments[2]).toEqual({ kind: 'text', value: '\ntrailing' });
  });
});
