import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deterministicSessionUuid,
  encodeCwdForClaudeProjects,
  validateResumeSession,
} from '../../src/workers/session.js';

describe('deterministicSessionUuid', () => {
  it('returns the same UUID for the same input every time', () => {
    const a = deterministicSessionUuid('symphony::project-1::main');
    const b = deterministicSessionUuid('symphony::project-1::main');
    expect(a).toBe(b);
  });

  it('produces different UUIDs for different inputs', () => {
    const a = deterministicSessionUuid('a');
    const b = deterministicSessionUuid('b');
    expect(a).not.toBe(b);
  });

  it('matches UUID v4 format', () => {
    const uuid = deterministicSessionUuid('some-stable-input');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('handles empty string input (still valid UUID)', () => {
    const uuid = deterministicSessionUuid('');
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('handles unicode input', () => {
    const uuid = deterministicSessionUuid('プロジェクト-🚀');
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('encodeCwdForClaudeProjects', () => {
  it('replaces POSIX separators with hyphens', () => {
    expect(encodeCwdForClaudeProjects('/home/chris/project')).toBe('-home-chris-project');
  });

  it('replaces Windows drive letter and backslashes', () => {
    expect(encodeCwdForClaudeProjects('C:\\Users\\chris\\project')).toBe(
      'C--Users-chris-project',
    );
  });

  it('handles mixed separators', () => {
    expect(encodeCwdForClaudeProjects('C:/Users\\mix/path')).toBe('C--Users-mix-path');
  });

  it('leaves path segments without separators unchanged', () => {
    expect(encodeCwdForClaudeProjects('simplename')).toBe('simplename');
  });
});

describe('validateResumeSession', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'symphony-session-'));
  });
  afterEach(() => {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function seedJsonl(cwd: string, sessionId: string): string {
    const encoded = encodeCwdForClaudeProjects(cwd);
    const dir = join(sandbox, '.claude', 'projects', encoded);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${sessionId}.jsonl`);
    writeFileSync(file, '', 'utf8');
    return file;
  }

  it('returns ok when the jsonl file exists and cwd matches', () => {
    const cwd = '/tmp/project-a';
    const sessionId = 'abc-123';
    const expected = seedJsonl(cwd, sessionId);
    const result = validateResumeSession({ sessionId, cwd, home: sandbox });
    expect(result).toEqual({ ok: true, sessionFile: expected });
  });

  it('returns missing when the file does not exist', () => {
    const result = validateResumeSession({
      sessionId: 'nope',
      cwd: '/tmp/p',
      home: sandbox,
    });
    expect(result).toEqual({ ok: false, reason: 'missing' });
  });

  it('returns empty_session_id for an empty session ID', () => {
    const result = validateResumeSession({ sessionId: '', cwd: '/tmp/p', home: sandbox });
    expect(result).toEqual({ ok: false, reason: 'empty_session_id' });
  });

  it('returns empty_cwd for an empty cwd', () => {
    const result = validateResumeSession({ sessionId: 'x', cwd: '', home: sandbox });
    expect(result).toEqual({ ok: false, reason: 'empty_cwd' });
  });

  it('distinguishes cwd mismatches from hits — session for cwd A does not validate cwd B', () => {
    const sessionId = 'shared';
    seedJsonl('/tmp/a', sessionId);
    const result = validateResumeSession({
      sessionId,
      cwd: '/tmp/b',
      home: sandbox,
    });
    expect(result).toEqual({ ok: false, reason: 'missing' });
  });
});
