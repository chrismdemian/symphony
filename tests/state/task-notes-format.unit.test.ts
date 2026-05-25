import { describe, expect, it } from 'vitest';
import {
  filterNotesSince,
  formatNotesAsMarkdown,
  formatTaskNoteTimestamp,
} from '../../src/state/task-notes-format.js';
import type { TaskNote } from '../../src/state/types.js';

describe('formatTaskNoteTimestamp', () => {
  it('renders ISO-Z as YYYY-MM-DD HH:MM:SS UTC', () => {
    expect(formatTaskNoteTimestamp('2026-05-21T14:23:07.456Z')).toBe(
      '2026-05-21 14:23:07 UTC',
    );
  });

  it('zero-pads single-digit fields', () => {
    expect(formatTaskNoteTimestamp('2026-01-02T03:04:05.000Z')).toBe(
      '2026-01-02 03:04:05 UTC',
    );
  });

  it('falls back to raw input on unparseable timestamp', () => {
    expect(formatTaskNoteTimestamp('not-a-date')).toBe('not-a-date');
  });

  it('handles timezone offsets by normalizing to UTC', () => {
    // '2026-05-21T10:00:00-04:00' == '2026-05-21T14:00:00Z'
    expect(formatTaskNoteTimestamp('2026-05-21T10:00:00-04:00')).toBe(
      '2026-05-21 14:00:00 UTC',
    );
  });
});

describe('formatNotesAsMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(formatNotesAsMarkdown([])).toBe('');
  });

  it('renders one section per note, headers + bodies', () => {
    const notes: TaskNote[] = [
      { at: '2026-05-21T10:00:00.000Z', text: 'first note' },
      { at: '2026-05-21T11:00:00.000Z', text: 'second note\nwith\nmultiple lines' },
    ];
    const out = formatNotesAsMarkdown(notes);
    expect(out).toContain('## 2026-05-21 10:00:00 UTC');
    expect(out).toContain('## 2026-05-21 11:00:00 UTC');
    expect(out).toContain('first note');
    expect(out).toContain('second note\nwith\nmultiple lines');
    // sections separated by a blank line
    expect(out).toMatch(/first note\n\n## 2026-05-21 11:00:00 UTC/);
  });

  it('preserves caller-supplied note ordering (does not sort)', () => {
    const notes: TaskNote[] = [
      { at: '2026-05-21T11:00:00.000Z', text: 'B' },
      { at: '2026-05-21T10:00:00.000Z', text: 'A' },
    ];
    const out = formatNotesAsMarkdown(notes);
    const idxA = out.indexOf('A');
    const idxB = out.indexOf('B');
    expect(idxB).toBeLessThan(idxA);
  });
});

describe('filterNotesSince', () => {
  const notes: TaskNote[] = [
    { at: '2026-05-21T10:00:00.000Z', text: 'A' },
    { at: '2026-05-21T11:00:00.000Z', text: 'B' },
    { at: '2026-05-21T12:00:00.000Z', text: 'C' },
  ];

  it('returns the full list when since is undefined', () => {
    expect(filterNotesSince(notes, undefined)).toEqual(notes);
  });

  it('returns the full list when since is unparseable', () => {
    expect(filterNotesSince(notes, 'not-a-date')).toEqual(notes);
  });

  it('keeps notes at or after since (inclusive)', () => {
    expect(filterNotesSince(notes, '2026-05-21T11:00:00.000Z')).toEqual([
      { at: '2026-05-21T11:00:00.000Z', text: 'B' },
      { at: '2026-05-21T12:00:00.000Z', text: 'C' },
    ]);
  });

  it('drops everything when since is after the latest note', () => {
    expect(filterNotesSince(notes, '2026-05-21T13:00:00.000Z')).toEqual([]);
  });

  it('keeps notes whose timestamp cannot be parsed (defensive)', () => {
    const mixed: TaskNote[] = [
      { at: 'unknown', text: 'X' },
      { at: '2026-05-21T10:00:00.000Z', text: 'A' },
    ];
    expect(filterNotesSince(mixed, '2026-05-21T11:00:00.000Z')).toEqual([
      { at: 'unknown', text: 'X' },
    ]);
  });

  it('returns a defensive copy, not the input array', () => {
    const out = filterNotesSince(notes, undefined);
    expect(out).not.toBe(notes);
    expect(out).toEqual(notes);
  });
});
