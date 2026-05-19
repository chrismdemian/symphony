import { describe, expect, it } from 'vitest';

import { parseDroidFile } from '../../src/droids/parse.js';
import { DroidParseError } from '../../src/droids/types.js';

const SRC = '/p/.symphony/droids/x.md';

const VALID = `---
name: dhh-reviewer
model: opus
tools_allowed: [read, grep]
tools_denied: [bash, edit]
---

You are a reviewer in DHH's style. Be ruthless about Rails conventions.
`;

describe('parseDroidFile — valid forms', () => {
  it('parses inline lists, scalar model, and the body', () => {
    const d = parseDroidFile(VALID, SRC, { expectedName: 'dhh-reviewer' });
    expect(d.name).toBe('dhh-reviewer');
    expect(d.model).toBe('opus');
    expect(d.toolsAllowed).toEqual(['read', 'grep']);
    expect(d.toolsDenied).toEqual(['bash', 'edit']);
    expect(d.writePaths).toBeUndefined();
    expect(d.body).toBe(
      "You are a reviewer in DHH's style. Be ruthless about Rails conventions.",
    );
    expect(d.source).toBe(SRC);
  });

  it('parses block lists + quoted write_paths; model optional', () => {
    const d = parseDroidFile(
      `---
name: design-researcher
tools_allowed:
  - read
  - grep
  - glob
  - write
tools_denied:
  - bash
  - edit
write_paths: ["DESIGN.md"]
---
Pick a design system. Write DESIGN.md.`,
      SRC,
      { expectedName: 'design-researcher' },
    );
    expect(d.model).toBeUndefined();
    expect(d.toolsAllowed).toEqual(['read', 'grep', 'glob', 'write']);
    expect(d.writePaths).toEqual(['DESIGN.md']);
  });

  it('tolerates CRLF, leading blank lines, frontmatter comments, bare/quoted scalars', () => {
    const raw =
      '\r\n\r\n---\r\n# a comment\r\nname: "quoted-name"\r\ntools_denied: [bash]\r\n---\r\nBody here.\r\n';
    const d = parseDroidFile(raw, SRC, { expectedName: 'quoted-name' });
    expect(d.name).toBe('quoted-name');
    expect(d.toolsDenied).toEqual(['bash']);
    expect(d.body).toBe('Body here.');
  });

  it('strips a leading UTF-8 BOM before the fence', () => {
    const bom = String.fromCharCode(0xfeff);
    const d = parseDroidFile(
      `${bom}---\nname: x\ntools_denied: [bash]\n---\nBody`,
      SRC,
      { expectedName: 'x' },
    );
    expect(d.name).toBe('x');
  });

  it('de-duplicates repeated tool tokens', () => {
    const d = parseDroidFile(
      `---\nname: x\ntools_allowed: [read, read, grep]\n---\nB`,
      SRC,
    );
    expect(d.toolsAllowed).toEqual(['read', 'grep']);
  });
});

describe('parseDroidFile — rejections (strict)', () => {
  const cases: Array<[string, string]> = [
    ['no opening fence', 'name: x\n---\nbody'],
    ['unterminated frontmatter', '---\nname: x\nbody with no close'],
    ['empty body', '---\nname: x\ntools_denied: [bash]\n---\n   \n'],
    ['missing name', '---\ntools_denied: [bash]\n---\nbody'],
    [
      'unknown frontmatter key',
      '---\nname: x\ntools_allowed: [read]\nbogus: 1\n---\nbody',
    ],
    [
      'duplicate key',
      '---\nname: x\ntools_denied: [bash]\ntools_denied: [edit]\n---\nbody',
    ],
    ['unknown tool token', '---\nname: x\ntools_allowed: [readz]\n---\nbody'],
    ['no policy declared', '---\nname: x\nmodel: opus\n---\nbody'],
    ['empty policy lists', '---\nname: x\ntools_allowed: []\ntools_denied: []\n---\nbody'],
    // 4F.1 audit M4 — `tools_allowed: []` (explicit empty) is
    // ambiguous; reject it even when `tools_denied` is non-empty.
    ['explicit-empty tools_allowed', '---\nname: x\ntools_allowed: []\ntools_denied: [bash]\n---\nbody'],
    ['explicit-empty tools_denied', '---\nname: x\ntools_allowed: [read]\ntools_denied: []\n---\nbody'],
    ['unsafe name', '---\nname: ../evil\ntools_denied: [bash]\n---\nbody'],
    [
      'absolute write_path',
      '---\nname: x\ntools_allowed: [write]\nwrite_paths: ["/etc/passwd"]\n---\nbody',
    ],
    [
      'traversal write_path',
      '---\nname: x\ntools_allowed: [write]\nwrite_paths: ["../../x"]\n---\nbody',
    ],
    ['malformed line', '---\nname x\ntools_denied: [bash]\n---\nbody'],
    ['stray list item', '---\n- read\nname: x\n---\nbody'],
  ];
  it.each(cases)('rejects %s', (_label, raw) => {
    expect(() => parseDroidFile(raw, SRC)).toThrow(DroidParseError);
  });

  it('rejects frontmatter name not matching expected filename stem', () => {
    expect(() =>
      parseDroidFile(`---\nname: foo\ntools_denied: [bash]\n---\nb`, SRC, {
        expectedName: 'bar',
      }),
    ).toThrow(/does not match expected/);
  });

  it('error carries the source path', () => {
    try {
      parseDroidFile('garbage', SRC);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DroidParseError);
      expect((err as DroidParseError).source).toBe(SRC);
    }
  });
});
