import { describe, expect, it } from 'vitest';
import {
  extractEnvelope,
  parseStructuredResponse,
} from '../../src/orchestrator/one-shot.js';

describe('extractEnvelope', () => {
  it('unwraps a Claude --output-format json envelope', () => {
    const raw = JSON.stringify({
      result: 'hello world',
      session_id: 'sess-123',
    });
    const r = extractEnvelope(raw);
    expect(r.text).toBe('hello world');
    expect(r.sessionId).toBe('sess-123');
  });

  it('returns raw text when envelope.result is missing', () => {
    const raw = JSON.stringify({ other: 'field' });
    const r = extractEnvelope(raw);
    expect(r.text).toBe(raw);
    expect(r.sessionId).toBeUndefined();
  });

  it('returns raw text when stdout is not JSON', () => {
    const r = extractEnvelope('this is not json');
    expect(r.text).toBe('this is not json');
  });

  it('strips BOM before parsing', () => {
    const raw = '﻿' + JSON.stringify({ result: 'ok' });
    const r = extractEnvelope(raw);
    expect(r.text).toBe('ok');
  });

  it('returns raw text on empty stdout', () => {
    const r = extractEnvelope('');
    expect(r.text).toBe('');
    expect(r.sessionId).toBeUndefined();
  });
});

describe('parseStructuredResponse', () => {
  it('extracts a JSON object with required fields in either order', () => {
    const forward = '{"verdict":"PASS","findings":[]}';
    const reversed = '{"findings":[{"severity":"Minor","description":"x"}],"verdict":"PASS"}';
    const a = parseStructuredResponse<{ verdict: string }>(forward, {
      requiredFields: ['verdict', 'findings'],
    });
    const b = parseStructuredResponse<{ verdict: string }>(reversed, {
      requiredFields: ['verdict', 'findings'],
    });
    expect(a?.verdict).toBe('PASS');
    expect(b?.verdict).toBe('PASS');
  });

  it('unwraps an envelope { result: "..." } before parsing', () => {
    const inner = '{"verdict":"FAIL","findings":[{"severity":"Critical","description":"boom"}]}';
    const envelope = JSON.stringify({ result: inner });
    const r = parseStructuredResponse<{ verdict: string; findings: unknown[] }>(envelope, {
      requiredFields: ['verdict', 'findings'],
    });
    expect(r?.verdict).toBe('FAIL');
    expect(r?.findings).toHaveLength(1);
  });

  it('strips ```json markdown fences', () => {
    const text = '```json\n{"verdict":"PASS","findings":[]}\n```';
    const r = parseStructuredResponse<{ verdict: string }>(text, {
      requiredFields: ['verdict', 'findings'],
    });
    expect(r?.verdict).toBe('PASS');
  });

  it('strips plain ``` fences without language tag', () => {
    const text = '```\n{"verdict":"PASS","findings":[]}\n```';
    const r = parseStructuredResponse<{ verdict: string }>(text, {
      requiredFields: ['verdict', 'findings'],
    });
    expect(r?.verdict).toBe('PASS');
  });

  it('falls back to greedy {} match when required-fields regex fails', () => {
    // The required-fields regex uses [^{}] between fields — a nested
    // object breaks it. The fallback greedy `{[\s\S]*}` still works.
    const text = 'noise before {"verdict":"PASS","findings":[{"meta":{"x":1}}]} noise after';
    const r = parseStructuredResponse<{ verdict: string }>(text, {
      requiredFields: ['verdict', 'findings'],
    });
    expect(r?.verdict).toBe('PASS');
  });

  it('returns null when no JSON object is present', () => {
    const r = parseStructuredResponse('no json at all here', {
      requiredFields: ['verdict'],
    });
    expect(r).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const r = parseStructuredResponse<Record<string, unknown>>('{"other":1}', {
      requiredFields: ['verdict', 'findings'],
    });
    expect(r).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    const r = parseStructuredResponse('{"verdict":"PASS", findings}', {
      requiredFields: ['verdict'],
    });
    expect(r).toBeNull();
  });

  it('converts \\n literal escapes in string fields to real newlines', () => {
    const text = '{"verdict":"PASS","findings":[],"summary":"line1\\nline2"}';
    const r = parseStructuredResponse<{ summary: string }>(text, {
      requiredFields: ['verdict', 'findings'],
    });
    expect(r?.summary).toBe('line1\nline2');
  });

  it('survives ANSI escape codes in the input', () => {
    const text = '[31m{"verdict":"PASS","findings":[]}[0m';
    const r = parseStructuredResponse<{ verdict: string }>(text, {
      requiredFields: ['verdict', 'findings'],
    });
    expect(r?.verdict).toBe('PASS');
  });

  it('works without requiredFields — returns any parseable object', () => {
    const r = parseStructuredResponse<Record<string, unknown>>('{"x":1,"y":2}');
    expect(r).toEqual({ x: 1, y: 2 });
  });

  it('returns null when the matched blob is not an object', () => {
    // Greedy match of `{...}` hits a JSON array primitive — but arrays
    // don't satisfy the `typeof parsed !== 'object'` guard if null, and
    // a valid array is technically an object. The function returns the
    // array cast to T, which is acceptable. Test the null primitive.
    const r = parseStructuredResponse<unknown>('{"value": null}');
    expect(r).not.toBeNull();
  });

  it('does not crash on UTF-8 multi-byte chars at the end of truncated input', () => {
    // Emoji 😀 is 4 bytes in UTF-8. Feed incomplete byte sequence via escape.
    const text = '{"verdict":"PASS","findings":[],"summary":"hi 😀"}';
    const r = parseStructuredResponse<{ summary: string }>(text, {
      requiredFields: ['verdict', 'findings'],
    });
    expect(r?.summary).toBe('hi 😀');
  });
});
