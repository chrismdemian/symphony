import { describe, it, expect } from 'vitest';
import { auditGlyphFor } from '../../../../src/ui/panels/audit/audit-glyph.js';
import { AUDIT_KINDS } from '../../../../src/state/audit-store.js';

describe('auditGlyphFor', () => {
  it('every AuditKind has a non-empty glyph + valid tone', () => {
    for (const kind of AUDIT_KINDS) {
      const g = auditGlyphFor(kind, 'info');
      expect(g.glyph.length).toBeGreaterThan(0);
      expect(['success', 'accent', 'warning', 'error', 'muted']).toContain(g.tone);
    }
  });

  it('info severity keeps the category base tone', () => {
    expect(auditGlyphFor('worker_completed', 'info').tone).toBe('success');
    expect(auditGlyphFor('tool_called', 'info').tone).toBe('muted');
    expect(auditGlyphFor('worker_spawned', 'info').tone).toBe('accent');
  });

  it('warn severity overrides tone to warning', () => {
    expect(auditGlyphFor('tool_denied', 'warn').tone).toBe('warning');
    // Even a normally-success kind goes warning under warn severity.
    expect(auditGlyphFor('worker_completed', 'warn').tone).toBe('warning');
  });

  it('error severity overrides tone to error', () => {
    expect(auditGlyphFor('tool_called', 'error').tone).toBe('error');
    expect(auditGlyphFor('merge_performed', 'error').tone).toBe('error');
  });

  it('glyph is independent of severity (only tone changes)', () => {
    const a = auditGlyphFor('merge_performed', 'info');
    const b = auditGlyphFor('merge_performed', 'error');
    expect(a.glyph).toBe(b.glyph);
    expect(a.tone).not.toBe(b.tone);
  });

  it('distinct glyphs for the major categories', () => {
    expect(auditGlyphFor('worker_completed', 'info').glyph).toBe('✓');
    expect(auditGlyphFor('worker_failed', 'info').glyph).toBe('✗');
    expect(auditGlyphFor('tool_called', 'info').glyph).toBe('·');
    expect(auditGlyphFor('tier_changed', 'info').glyph).toBe('⚙');
    expect(auditGlyphFor('error', 'info').glyph).toBe('⚠');
    expect(auditGlyphFor('worker_interrupted', 'info').glyph).toBe('⏸');
  });
});
