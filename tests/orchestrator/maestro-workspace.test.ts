import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureMaestroWorkspace,
  writeMaestroClaudeMd,
} from '../../src/orchestrator/maestro/workspace.js';

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'symphony-maestro-ws-'));
});

afterEach(() => {
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('ensureMaestroWorkspace', () => {
  it('creates ~/.symphony/maestro/ when absent and returns absolute paths', async () => {
    const ws = await ensureMaestroWorkspace({ home: sandbox });
    expect(ws.cwd).toBe(join(sandbox, '.symphony', 'maestro'));
    expect(ws.claudeMdPath).toBe(join(ws.cwd, 'CLAUDE.md'));
    expect(statSync(ws.cwd).isDirectory()).toBe(true);
  });

  it('is idempotent — second call on an already-created workspace is a no-op', async () => {
    const first = await ensureMaestroWorkspace({ home: sandbox });
    writeFileSync(join(first.cwd, 'sentinel'), 'preserved', 'utf8');
    const second = await ensureMaestroWorkspace({ home: sandbox });
    expect(second.cwd).toBe(first.cwd);
    // Pre-existing file survives a re-ensure
    expect(readFileSync(join(second.cwd, 'sentinel'), 'utf8')).toBe('preserved');
  });
});

describe('writeMaestroClaudeMd', () => {
  it('atomically writes the file (no .tmp leak on success)', async () => {
    const ws = await ensureMaestroWorkspace({ home: sandbox });
    await writeMaestroClaudeMd(ws.claudeMdPath, 'hello maestro');
    expect(readFileSync(ws.claudeMdPath, 'utf8')).toBe('hello maestro');
    const leftovers = readdirSync(ws.cwd).filter((f) => f.startsWith('CLAUDE.md.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('overwrites existing content', async () => {
    const ws = await ensureMaestroWorkspace({ home: sandbox });
    await writeMaestroClaudeMd(ws.claudeMdPath, 'first');
    await writeMaestroClaudeMd(ws.claudeMdPath, 'second');
    expect(readFileSync(ws.claudeMdPath, 'utf8')).toBe('second');
  });
});
