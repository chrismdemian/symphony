/**
 * Phase 3R — AuditKind → glyph + tone mapping. Mirrors
 * `DepsPanel.statusGlyphFor` shape so the /log popup chrome is visually
 * consistent with /deps, /stats, and the chat status rows.
 *
 * Glyph by category; severity tone overrides the color so a `warn`
 * tool_denied reads gold even though its base category glyph is `·`.
 */

import type { AuditKind, AuditSeverity } from '../../../state/audit-store.js';

export type AuditTone = 'success' | 'accent' | 'warning' | 'error' | 'muted';

export interface AuditGlyph {
  readonly glyph: string;
  readonly tone: AuditTone;
}

const KIND_GLYPH: Record<AuditKind, string> = {
  worker_spawned: '●',
  worker_completed: '✓',
  worker_failed: '✗',
  worker_crashed: '✗',
  worker_timeout: '◴',
  worker_killed: '○',
  worker_interrupted: '⏸',
  question_asked: '?',
  question_answered: '✓',
  merge_performed: '✓',
  merge_declined: '○',
  merge_failed: '✗',
  merge_ready: '◆',
  tier_changed: '⚙',
  model_mode_changed: '⚙',
  away_mode_changed: '⚙',
  tool_called: '·',
  tool_denied: '⊘',
  tool_error: '✗',
  error: '⚠',
};

const KIND_BASE_TONE: Record<AuditKind, AuditTone> = {
  worker_spawned: 'accent',
  worker_completed: 'success',
  worker_failed: 'error',
  worker_crashed: 'error',
  worker_timeout: 'warning',
  worker_killed: 'muted',
  worker_interrupted: 'muted',
  question_asked: 'accent',
  question_answered: 'success',
  merge_performed: 'success',
  merge_declined: 'muted',
  merge_failed: 'error',
  merge_ready: 'accent',
  tier_changed: 'muted',
  model_mode_changed: 'muted',
  away_mode_changed: 'muted',
  tool_called: 'muted',
  tool_denied: 'warning',
  tool_error: 'error',
  error: 'error',
};

const SEVERITY_TONE: Record<AuditSeverity, AuditTone | null> = {
  // info doesn't override — keep the category's own tone.
  info: null,
  warn: 'warning',
  error: 'error',
};

export function auditGlyphFor(
  kind: AuditKind,
  severity: AuditSeverity,
): AuditGlyph {
  const glyph = KIND_GLYPH[kind] ?? '·';
  const override = SEVERITY_TONE[severity];
  const tone = override ?? KIND_BASE_TONE[kind] ?? 'muted';
  return { glyph, tone };
}
