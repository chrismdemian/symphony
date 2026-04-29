import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveMaestroSession,
  MAESTRO_SESSION_UUID,
} from '../../src/orchestrator/maestro/session.js';
import { encodeCwdForClaudeProjects } from '../../src/workers/session.js';

let sandbox: string;
let cwd: string;
let home: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-maestro-session-'));
  home = join(sandbox, 'home');
  cwd = join(sandbox, 'maestro-cwd');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function seedSessionFile(): string {
  const encoded = encodeCwdForClaudeProjects(cwd);
  const dir = join(home, '.claude', 'projects', encoded);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${MAESTRO_SESSION_UUID}.jsonl`);
  writeFileSync(file, '', 'utf8');
  return file;
}

describe('MAESTRO_SESSION_UUID', () => {
  it('is a valid v4 UUID derived deterministically from the sentinel', () => {
    // Same value every test run, every machine.
    expect(MAESTRO_SESSION_UUID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('resolveMaestroSession', () => {
  it('returns mode=fresh + freshReason=missing when session file does not exist', () => {
    const result = resolveMaestroSession({ cwd, home });
    expect(result.sessionId).toBe(MAESTRO_SESSION_UUID);
    expect(result.mode).toBe('fresh');
    expect(result.freshReason).toBe('missing');
    expect(result.sessionFile).toBeUndefined();
  });

  it('returns mode=resume when session file exists at the encoded-cwd path', () => {
    const expectedFile = seedSessionFile();
    const result = resolveMaestroSession({ cwd, home });
    expect(result.sessionId).toBe(MAESTRO_SESSION_UUID);
    expect(result.mode).toBe('resume');
    expect(result.sessionFile).toBe(expectedFile);
    expect(result.freshReason).toBeUndefined();
  });

  it('returns mode=fresh when cwd differs from where the session file was originally created', () => {
    seedSessionFile();
    const otherCwd = join(sandbox, 'different-cwd');
    mkdirSync(otherCwd, { recursive: true });
    const result = resolveMaestroSession({ cwd: otherCwd, home });
    expect(result.mode).toBe('fresh');
    expect(result.freshReason).toBe('missing');
  });

  it('UUID is stable across calls (sentinel-derived, not cwd-derived)', () => {
    const a = resolveMaestroSession({ cwd, home });
    const b = resolveMaestroSession({ cwd: '/other/path', home });
    expect(a.sessionId).toBe(b.sessionId);
  });
});
