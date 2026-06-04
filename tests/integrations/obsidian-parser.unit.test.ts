import { describe, expect, it } from 'vitest';
import {
  bodyStartLine,
  classifyStatusChar,
  cleanDescription,
  computeLocator,
  defaultStatusMap,
  detectTaskFormat,
  parseTaskLine,
  parseTasksFromBody,
  rewriteTaskLineStatus,
} from '../../src/integrations/obsidian-parser.js';

describe('classifyStatusChar', () => {
  it('classifies the core status chars', () => {
    expect(classifyStatusChar(' ')).toEqual({ status: 'pending', terminal: false });
    expect(classifyStatusChar('/')).toEqual({ status: 'in_progress', terminal: false });
    expect(classifyStatusChar('x')).toEqual({ status: 'completed', terminal: true });
    expect(classifyStatusChar('X')).toEqual({ status: 'completed', terminal: true });
    expect(classifyStatusChar('-')).toEqual({ status: 'cancelled', terminal: true });
  });

  it('treats forwarded / question chars as open pending (not skipped)', () => {
    expect(classifyStatusChar('>')).toEqual({ status: 'pending', terminal: false });
    expect(classifyStatusChar('?')).toEqual({ status: 'pending', terminal: false });
  });

  it('treats an unknown char as open pending', () => {
    expect(classifyStatusChar('z')).toEqual({ status: 'pending', terminal: false });
  });

  it('honors a user override map', () => {
    const map = defaultStatusMap();
    map['z'] = { status: 'in_progress', terminal: false };
    expect(classifyStatusChar('z', map)).toEqual({ status: 'in_progress', terminal: false });
  });
});

describe('parseTaskLine', () => {
  it('parses a basic unchecked task', () => {
    const t = parseTaskLine('- [ ] Write the parser', { format: 'emoji' });
    expect(t?.statusChar).toBe(' ');
    expect(t?.status).toBe('pending');
    expect(t?.terminal).toBe(false);
    expect(t?.description).toBe('Write the parser');
  });

  it('returns undefined for non-task lines', () => {
    expect(parseTaskLine('Just prose', { format: 'emoji' })).toBeUndefined();
    expect(parseTaskLine('## A heading', { format: 'emoji' })).toBeUndefined();
    expect(parseTaskLine('- a bullet without a checkbox', { format: 'emoji' })).toBeUndefined();
    expect(parseTaskLine('', { format: 'emoji' })).toBeUndefined();
  });

  it('accepts *, +, and ordered list markers', () => {
    expect(parseTaskLine('* [ ] star', { format: 'emoji' })?.description).toBe('star');
    expect(parseTaskLine('+ [ ] plus', { format: 'emoji' })?.description).toBe('plus');
    expect(parseTaskLine('1. [ ] ordered', { format: 'emoji' })?.description).toBe('ordered');
    expect(parseTaskLine('3) [ ] paren', { format: 'emoji' })?.description).toBe('paren');
  });

  it('parses indented / blockquoted tasks', () => {
    expect(parseTaskLine('    - [ ] nested', { format: 'emoji' })?.description).toBe('nested');
    expect(parseTaskLine('> - [ ] quoted', { format: 'emoji' })?.description).toBe('quoted');
  });

  it('strips trailing emoji metadata from the description', () => {
    const t = parseTaskLine('- [ ] Ship it 📅 2026-06-10 ⏫ 🔁 every week', { format: 'emoji' });
    expect(t?.description).toBe('Ship it');
    expect(t?.priority).toBe(2);
  });

  it('maps every emoji priority signifier', () => {
    expect(parseTaskLine('- [ ] a 🔺', { format: 'emoji' })?.priority).toBe(3);
    expect(parseTaskLine('- [ ] a ⏫', { format: 'emoji' })?.priority).toBe(2);
    expect(parseTaskLine('- [ ] a 🔼', { format: 'emoji' })?.priority).toBe(1);
    expect(parseTaskLine('- [ ] a 🔽', { format: 'emoji' })?.priority).toBe(-1);
    expect(parseTaskLine('- [ ] a ⏬', { format: 'emoji' })?.priority).toBe(-2);
    expect(parseTaskLine('- [ ] a', { format: 'emoji' })?.priority).toBe(0);
  });

  it('parses Dataview-format metadata + priority', () => {
    const t = parseTaskLine('- [ ] Do thing [due:: 2026-06-10] [priority:: high]', {
      format: 'dataview',
    });
    expect(t?.description).toBe('Do thing');
    expect(t?.priority).toBe(2);
  });

  it('strips inline tags from the description', () => {
    const t = parseTaskLine('- [ ] Refactor #work #urgent', { format: 'emoji' });
    expect(t?.description).toBe('Refactor');
  });

  it('falls back to a placeholder for an empty description', () => {
    const t = parseTaskLine('- [ ] 📅 2026-06-10', { format: 'emoji' });
    expect(t?.description).toBe('(untitled task)');
  });
});

describe('computeLocator', () => {
  it('prefers a Tasks 🆔 id', () => {
    const rest = 'Do thing 🆔 abc123 📅 2026-06-10';
    expect(computeLocator(rest, cleanDescription(rest))).toBe('id:abc123');
  });

  it('falls back to a trailing block id', () => {
    const rest = 'Do thing ^my-block';
    expect(computeLocator(rest, cleanDescription(rest))).toBe('^my-block');
  });

  it('falls back to a content hash when no anchor is present', () => {
    const rest = 'Do thing';
    const loc = computeLocator(rest, cleanDescription(rest));
    expect(loc).toMatch(/^h:[0-9a-f]{16}$/u);
  });

  it('content hash is stable for the same description and differs across text', () => {
    const a = computeLocator('Same text', cleanDescription('Same text'));
    const b = computeLocator('Same text 📅 2026-06-10', cleanDescription('Same text 📅 2026-06-10'));
    const c = computeLocator('Other text', cleanDescription('Other text'));
    // a and b share a description ("Same text") → same hash despite differing metadata.
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('detectTaskFormat', () => {
  it('detects emoji format', () => {
    expect(detectTaskFormat(['- [ ] x 📅 2026-06-10'])).toBe('emoji');
  });
  it('detects dataview format', () => {
    expect(detectTaskFormat(['- [ ] x [due:: 2026-06-10]'])).toBe('dataview');
  });
  it('defaults to emoji when neither is present', () => {
    expect(detectTaskFormat(['- [ ] plain task'])).toBe('emoji');
  });
});

describe('parseTasksFromBody', () => {
  it('extracts only task lines, skipping prose and headings', () => {
    const body = ['# Notes', '', '- [ ] one', 'some prose', '- [/] two', '* [x] three (done)'].join(
      '\n',
    );
    const tasks = parseTasksFromBody(body);
    expect(tasks.map((t) => t.description)).toEqual(['one', 'two', 'three (done)']);
    expect(tasks.map((t) => t.status)).toEqual(['pending', 'in_progress', 'completed']);
  });

  it('skips tasks inside fenced code blocks', () => {
    const body = [
      '- [ ] real task',
      '```md',
      '- [ ] example inside a code fence',
      '```',
      '- [ ] another real task',
    ].join('\n');
    const tasks = parseTasksFromBody(body);
    expect(tasks.map((t) => t.description)).toEqual(['real task', 'another real task']);
  });

  it('tracks body line indices (used by writeback)', () => {
    const body = ['intro', '- [ ] first', '', '- [ ] second'].join('\n');
    const tasks = parseTasksFromBody(body);
    expect(tasks[0]?.lineIndex).toBe(1);
    expect(tasks[1]?.lineIndex).toBe(3);
  });

  it('honors ~~~ fences as well as ```', () => {
    const body = ['~~~', '- [ ] hidden', '~~~', '- [ ] shown'].join('\n');
    expect(parseTasksFromBody(body).map((t) => t.description)).toEqual(['shown']);
  });

  it('disambiguates identical task lines with an occurrence ordinal (audit M2)', () => {
    const body = ['- [ ] Reply to Bob', '- [ ] Reply to Bob', '- [ ] Reply to Bob'].join('\n');
    const tasks = parseTasksFromBody(body);
    expect(tasks).toHaveLength(3);
    const [a, b, c] = tasks;
    // First keeps the base hash; subsequent get :2 / :3.
    expect(a?.locator).toMatch(/^h:[0-9a-f]{16}$/u);
    expect(b?.locator).toBe(`${a?.locator}:2`);
    expect(c?.locator).toBe(`${a?.locator}:3`);
    // All three are distinct → all three round-trip to distinct tasks.
    expect(new Set(tasks.map((t) => t.locator)).size).toBe(3);
  });
});

describe('bodyStartLine', () => {
  it('returns 0 when there is no frontmatter', () => {
    expect(bodyStartLine(['- [ ] task', 'prose'])).toBe(0);
  });

  it('returns the line after the closing --- for a frontmatter block', () => {
    expect(bodyStartLine(['---', 'project: x', 'tags:', '  - a', '---', '- [ ] task'])).toBe(5);
  });

  it('returns 0 when the opening --- has no closing delimiter (no frontmatter)', () => {
    expect(bodyStartLine(['---', 'project: x', '- [ ] task'])).toBe(0);
  });

  it('returns 0 when the first line is not the delimiter', () => {
    expect(bodyStartLine(['', '---', 'x', '---'])).toBe(0);
  });
});

describe('rewriteTaskLineStatus', () => {
  it('flips an unchecked box to done, preserving indentation and text', () => {
    const out = rewriteTaskLineStatus('   - [ ] Do thing', 'x');
    expect(out).toBe('   - [x] Do thing');
  });

  it('appends a done-date stamp when requested', () => {
    const out = rewriteTaskLineStatus('- [ ] Do thing', 'x', { doneDate: '2026-06-10' });
    expect(out).toBe('- [x] Do thing ✅ 2026-06-10');
  });

  it('does not double-stamp an existing done date', () => {
    const out = rewriteTaskLineStatus('- [/] Do thing ✅ 2026-06-01', 'x', {
      doneDate: '2026-06-10',
    });
    expect(out).toBe('- [x] Do thing ✅ 2026-06-01');
  });

  it('returns undefined for a no-op (already target char, no stamp wanted)', () => {
    expect(rewriteTaskLineStatus('- [x] done', 'x')).toBeUndefined();
  });

  it('returns undefined for a non-task line', () => {
    expect(rewriteTaskLineStatus('not a task', 'x')).toBeUndefined();
  });

  it('flips an in-progress task and keeps its metadata', () => {
    const out = rewriteTaskLineStatus('- [/] Ship 📅 2026-06-10 ⏫', 'x');
    expect(out).toBe('- [x] Ship 📅 2026-06-10 ⏫');
  });

  it('preserves a multi-space gap between marker and checkbox', () => {
    const out = rewriteTaskLineStatus('-  [ ]  Spaced', 'x');
    expect(out).toBe('-  [x]  Spaced');
  });
});
