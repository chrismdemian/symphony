import { describe, it, expect } from 'vitest';
import { colorizeDiff } from '../../../../src/ui/panels/output/diffColorize.js';

describe('colorizeDiff (Phase 3F.4)', () => {
  it('classifies + lines as add', () => {
    const lines = colorizeDiff('+ added line');
    expect(lines).toEqual([{ kind: 'add', text: '+ added line' }]);
  });

  it('classifies - lines as remove', () => {
    const lines = colorizeDiff('- removed line');
    expect(lines).toEqual([{ kind: 'remove', text: '- removed line' }]);
  });

  it('classifies @@ lines as hunk', () => {
    const lines = colorizeDiff('@@ -1,3 +1,4 @@');
    expect(lines).toEqual([{ kind: 'hunk', text: '@@ -1,3 +1,4 @@' }]);
  });

  it('classifies +++/--- file headers as meta (not add/remove)', () => {
    const lines = colorizeDiff('--- a/foo\n+++ b/foo');
    expect(lines).toEqual([
      { kind: 'meta', text: '--- a/foo' },
      { kind: 'meta', text: '+++ b/foo' },
    ]);
  });

  it('classifies "\\ No newline at end of file" as meta', () => {
    const lines = colorizeDiff('\\ No newline at end of file');
    expect(lines).toEqual([
      { kind: 'meta', text: '\\ No newline at end of file' },
    ]);
  });

  it('classifies unprefixed lines as context', () => {
    const lines = colorizeDiff(' unchanged line');
    expect(lines).toEqual([{ kind: 'context', text: ' unchanged line' }]);
  });

  it('handles a multi-line unified diff', () => {
    const source = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' const x = 1;',
      '-const y = 2;',
      '+const y = 3;',
      ' return x + y;',
    ].join('\n');
    const lines = colorizeDiff(source);
    expect(lines.map((l) => l.kind)).toEqual([
      'meta',
      'meta',
      'hunk',
      'context',
      'remove',
      'add',
      'context',
    ]);
  });

  it('preserves text exactly per line', () => {
    const source = '+a\n-b\n c';
    const lines = colorizeDiff(source);
    expect(lines.map((l) => l.text)).toEqual(['+a', '-b', ' c']);
  });

  it('handles empty input', () => {
    const lines = colorizeDiff('');
    expect(lines).toEqual([{ kind: 'context', text: '' }]);
  });

  it('does NOT classify `-- heading` as remove (audit M2)', () => {
    // A two-dash heading inside a diff fence (e.g. user notes) used to
    // misclassify as `remove` because the original code only excluded
    // 3+ dashes. Now correctly falls through to context.
    const lines = colorizeDiff('-- Notes:');
    expect(lines).toEqual([{ kind: 'context', text: '-- Notes:' }]);
  });

  it('does NOT classify `++ heading` as add (audit M2)', () => {
    const lines = colorizeDiff('++ Section');
    expect(lines).toEqual([{ kind: 'context', text: '++ Section' }]);
  });

  it('classifies `+ ` (single + then space) as add', () => {
    const lines = colorizeDiff('+ added with leading space');
    expect(lines[0]?.kind).toBe('add');
  });

  it('classifies bare `+` and bare `-` as add/remove (empty diff lines)', () => {
    expect(colorizeDiff('+')[0]?.kind).toBe('add');
    expect(colorizeDiff('-')[0]?.kind).toBe('remove');
  });
});
