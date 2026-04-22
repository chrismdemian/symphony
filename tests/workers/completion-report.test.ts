import { describe, it, expect } from 'vitest';
import { scanForCompletionReport } from '../../src/workers/completion-report.js';

const validBody = {
  did: ['wrote types.ts'],
  skipped: [],
  blockers: [],
  open_questions: [],
  audit: 'PASS',
  cite: ['src/workers/types.ts:1'],
  tests_run: ['pnpm test: ok'],
  preview_url: null,
};

function fence(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

describe('scanForCompletionReport', () => {
  it('returns none when no fenced json block exists', () => {
    const r = scanForCompletionReport('just some text with no fence');
    expect(r.kind).toBe('none');
  });

  it('returns valid for a well-formed Phase 4E report', () => {
    const r = scanForCompletionReport('## Completion Report\n' + fence(validBody));
    expect(r.kind).toBe('valid');
    expect(r.report?.did).toEqual(['wrote types.ts']);
    expect(r.report?.audit).toBe('PASS');
    expect(r.raw).toContain('did');
  });

  it('keeps the LAST VALID fenced block when multiple are present', () => {
    const earlier = { ...validBody, audit: 'FAIL' as const };
    const text = fence(earlier) + '\n\nsome commentary\n\n' + fence(validBody);
    const r = scanForCompletionReport(text);
    expect(r.kind).toBe('valid');
    expect(r.report?.audit).toBe('PASS');
  });

  it('falls back past a trailing unrelated json fence to a valid prior report', () => {
    const text =
      'Completion report:\n' +
      fence(validBody) +
      '\n\nFor reference, example schema I used:\n' +
      '```json\n{"x": 1}\n```';
    const r = scanForCompletionReport(text);
    expect(r.kind).toBe('valid');
    expect(r.report?.audit).toBe('PASS');
    expect(r.report?.did).toEqual(['wrote types.ts']);
  });

  it('handles CRLF-terminated fences (Windows-authored text)', () => {
    const body = JSON.stringify(validBody, null, 2);
    const crlfFence = '```json\r\n' + body + '\r\n```';
    const r = scanForCompletionReport(crlfFence);
    expect(r.kind).toBe('valid');
    expect(r.report?.audit).toBe('PASS');
  });

  it('returns the last match invalid reason when no fence validates', () => {
    const text = fence({ not: 'a report' }) + '\n\n' + '```json\n{"also": "nope"}\n```';
    const r = scanForCompletionReport(text);
    expect(r.kind).toBe('invalid');
    expect(r.reason).toBeDefined();
  });

  it('returns invalid when fence contains malformed json', () => {
    const text = '```json\n{not json}\n```';
    const r = scanForCompletionReport(text);
    expect(r.kind).toBe('invalid');
    expect(r.reason).toContain('json parse failed');
  });

  it('returns invalid when required fields are missing', () => {
    const { did: _did, ...rest } = validBody;
    const r = scanForCompletionReport(fence(rest));
    expect(r.kind).toBe('invalid');
    expect(r.reason).toContain('did');
  });

  it('returns invalid when audit is not PASS or FAIL', () => {
    const r = scanForCompletionReport(fence({ ...validBody, audit: 'MAYBE' }));
    expect(r.kind).toBe('invalid');
    expect(r.reason).toContain('audit');
  });

  it('returns invalid when preview_url is neither string nor null', () => {
    const r = scanForCompletionReport(fence({ ...validBody, preview_url: 42 }));
    expect(r.kind).toBe('invalid');
    expect(r.reason).toContain('preview_url');
  });

  it('returns invalid when a string array contains non-strings', () => {
    const r = scanForCompletionReport(fence({ ...validBody, cite: ['ok', 5] }));
    expect(r.kind).toBe('invalid');
    expect(r.reason).toContain('cite');
  });

  it('accepts optional display field as any shape', () => {
    const r = scanForCompletionReport(
      fence({ ...validBody, display: { type: 'Card', children: [] } }),
    );
    expect(r.kind).toBe('valid');
    expect(r.report?.display).toEqual({ type: 'Card', children: [] });
  });

  it('accepts empty arrays for list fields', () => {
    const r = scanForCompletionReport(fence(validBody));
    expect(r.kind).toBe('valid');
    expect(r.report?.skipped).toEqual([]);
  });
});
