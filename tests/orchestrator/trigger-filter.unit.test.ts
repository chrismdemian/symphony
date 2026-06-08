import { describe, expect, it, vi } from 'vitest';
import {
  buildTriggerConfigJson,
  describeTriggerFilters,
  matchesTriggerFilters,
  parseTriggerConfig,
} from '../../src/orchestrator/trigger-filter.js';
import type { RawTriggerEvent } from '../../src/orchestrator/automation-trigger-source.js';

/**
 * Phase 8D.4 — trigger filter matching. Pure functions; no store/engine.
 */

function ev(over: Partial<RawTriggerEvent> = {}): RawTriggerEvent {
  return {
    id: 'github:o/r#1',
    title: 'A bug',
    url: null,
    type: 'GitHub issue',
    labels: [],
    assignee: null,
    ...over,
  };
}

describe('parseTriggerConfig', () => {
  it('null column → null (no filtering)', () => {
    expect(parseTriggerConfig(null)).toBeNull();
  });

  it('unparseable JSON → null + warns (fail-open)', () => {
    const log = vi.fn();
    expect(parseTriggerConfig('{not json', log)).toBeNull();
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('not valid JSON'));
  });

  it('non-object JSON (array / scalar / null) → null + warns', () => {
    const log = vi.fn();
    expect(parseTriggerConfig('[1,2]', log)).toBeNull();
    expect(parseTriggerConfig('42', log)).toBeNull();
    expect(parseTriggerConfig('null', log)).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('empty object / all-blank fields → null (nothing usable)', () => {
    expect(parseTriggerConfig('{}')).toBeNull();
    expect(parseTriggerConfig('{"labelFilter":[],"assigneeFilter":"  "}')).toBeNull();
  });

  it('drops invalid individual fields but keeps the rest', () => {
    const cfg = parseTriggerConfig(
      '{"labelFilter":["bug",2,"",null,"urgent"],"assigneeFilter":"chris","branchFilter":123}',
    );
    expect(cfg).toEqual({ labelFilter: ['bug', 'urgent'], assigneeFilter: 'chris' });
  });

  it('parses a full config', () => {
    const cfg = parseTriggerConfig(
      '{"labelFilter":["bug"],"assigneeFilter":"chris","branchFilter":"feature/*"}',
    );
    expect(cfg).toEqual({
      labelFilter: ['bug'],
      assigneeFilter: 'chris',
      branchFilter: 'feature/*',
    });
  });
});

describe('matchesTriggerFilters', () => {
  it('null config matches everything', () => {
    expect(matchesTriggerFilters(ev(), null)).toBe(true);
  });

  describe('labelFilter (case-insensitive OR)', () => {
    it('matches when the event carries one of the labels (any case)', () => {
      expect(matchesTriggerFilters(ev({ labels: ['Bug'] }), { labelFilter: ['bug'] })).toBe(true);
      expect(
        matchesTriggerFilters(ev({ labels: ['enhancement', 'URGENT'] }), {
          labelFilter: ['bug', 'urgent'],
        }),
      ).toBe(true);
    });

    it('rejects when no label overlaps', () => {
      expect(
        matchesTriggerFilters(ev({ labels: ['docs'] }), { labelFilter: ['bug'] }),
      ).toBe(false);
    });

    it('rejects an event with no labels', () => {
      expect(matchesTriggerFilters(ev({ labels: [] }), { labelFilter: ['bug'] })).toBe(false);
    });
  });

  describe('assigneeFilter (case-insensitive exact)', () => {
    it('matches the assignee regardless of case', () => {
      expect(matchesTriggerFilters(ev({ assignee: 'Chris' }), { assigneeFilter: 'chris' })).toBe(
        true,
      );
    });

    it('rejects a different assignee', () => {
      expect(matchesTriggerFilters(ev({ assignee: 'bob' }), { assigneeFilter: 'chris' })).toBe(
        false,
      );
    });

    it('rejects an unassigned event', () => {
      expect(matchesTriggerFilters(ev({ assignee: null }), { assigneeFilter: 'chris' })).toBe(
        false,
      );
    });
  });

  describe('branchFilter (glob; PR sources only)', () => {
    it('IGNORED for issue events with no branch (does not suppress)', () => {
      // Symphony divergence from emdash: issue sources carry no branch, so a
      // stray branch filter must NOT filter everything out.
      expect(matchesTriggerFilters(ev({ branch: undefined }), { branchFilter: 'feature/*' })).toBe(
        true,
      );
      expect(matchesTriggerFilters(ev({ branch: null }), { branchFilter: 'feature/*' })).toBe(true);
    });

    it('glob-matches a branch when present', () => {
      expect(
        matchesTriggerFilters(ev({ branch: 'feature/auth' }), { branchFilter: 'feature/*' }),
      ).toBe(true);
      expect(
        matchesTriggerFilters(ev({ branch: 'fix/bug' }), { branchFilter: 'feature/*' }),
      ).toBe(false);
    });

    it('exact-matches a branch with no wildcard', () => {
      expect(matchesTriggerFilters(ev({ branch: 'main' }), { branchFilter: 'main' })).toBe(true);
      expect(matchesTriggerFilters(ev({ branch: 'develop' }), { branchFilter: 'main' })).toBe(
        false,
      );
    });

    it('escapes regex metachars in the glob (literal dots)', () => {
      expect(matchesTriggerFilters(ev({ branch: 'releaseX1' }), { branchFilter: 'release.1' })).toBe(
        false,
      );
      expect(matchesTriggerFilters(ev({ branch: 'release.1' }), { branchFilter: 'release.1' })).toBe(
        true,
      );
    });
  });

  it('AND across filter kinds — all must pass', () => {
    const config = { labelFilter: ['bug'], assigneeFilter: 'chris' };
    expect(matchesTriggerFilters(ev({ labels: ['bug'], assignee: 'chris' }), config)).toBe(true);
    expect(matchesTriggerFilters(ev({ labels: ['bug'], assignee: 'bob' }), config)).toBe(false);
    expect(matchesTriggerFilters(ev({ labels: ['docs'], assignee: 'chris' }), config)).toBe(false);
  });
});

describe('buildTriggerConfigJson', () => {
  it('returns null when no usable filter is given', () => {
    expect(buildTriggerConfigJson({})).toBeNull();
    expect(buildTriggerConfigJson({ labels: ['  ', ''] })).toBeNull();
    expect(buildTriggerConfigJson({ assignee: '   ' })).toBeNull();
  });

  it('builds a JSON config, trimming blanks', () => {
    const json = buildTriggerConfigJson({
      labels: [' bug ', '', 'urgent'],
      assignee: ' chris ',
      branch: 'feature/*',
    });
    expect(JSON.parse(json!)).toEqual({
      labelFilter: ['bug', 'urgent'],
      assigneeFilter: 'chris',
      branchFilter: 'feature/*',
    });
  });

  it('round-trips through parseTriggerConfig', () => {
    const json = buildTriggerConfigJson({ labels: ['bug'], assignee: 'chris' });
    expect(parseTriggerConfig(json)).toEqual({ labelFilter: ['bug'], assigneeFilter: 'chris' });
  });
});

describe('describeTriggerFilters', () => {
  it('empty string for null', () => {
    expect(describeTriggerFilters(null)).toBe('');
  });

  it('formats each present filter', () => {
    expect(
      describeTriggerFilters({
        labelFilter: ['bug', 'urgent'],
        assigneeFilter: 'chris',
        branchFilter: 'feature/*',
      }),
    ).toBe('label:bug,urgent assignee:chris branch:feature/*');
  });
});
