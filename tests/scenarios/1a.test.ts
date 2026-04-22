import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseStream } from '../../src/workers/stream-parser.js';
import type { StreamEvent } from '../../src/workers/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeClaude = join(__dirname, '..', 'helpers', 'fake-claude.mjs');

async function runSession(fixture: string): Promise<{
  events: StreamEvent[];
  exitCode: number | null;
  stderr: string;
}> {
  const child = spawn(process.execPath, [fakeClaude, fixture], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const events: StreamEvent[] = [];
  const parsing = (async () => {
    for await (const ev of parseStream(child.stdout)) events.push(ev);
  })();
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
  });
  await parsing;
  return { events, exitCode, stderr };
}

describe('Phase 1A production scenario', () => {
  it('parses a structured-completion worker session end-to-end', async () => {
    const { events, exitCode, stderr } = await runSession('structured-completion');

    // Subprocess health
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');

    // Expected event sequence
    expect(events.map((e) => e.type)).toEqual([
      'system_init',
      'assistant_text',
      'structured_completion',
      'result',
    ]);
    expect(events.some((e) => e.type === 'parse_error')).toBe(false);

    const init = events[0];
    const structured = events[2];
    const result = events[3];

    if (init?.type !== 'system_init') throw new Error('expected system_init');
    if (structured?.type !== 'structured_completion')
      throw new Error('expected structured_completion');
    if (result?.type !== 'result') throw new Error('expected result');

    // system_init observability
    expect(init.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.tools?.length ?? 0).toBeGreaterThan(0);

    // assistant_text has content
    const firstText = events[1];
    if (firstText?.type === 'assistant_text') {
      expect(firstText.text.length).toBeGreaterThan(0);
    }

    // Structured completion contract
    expect(['PASS', 'FAIL']).toContain(structured.report.audit);
    expect(structured.report.did.length).toBeGreaterThan(0);
    expect(Array.isArray(structured.report.cite)).toBe(true);

    // Result contract
    expect(result.sessionId).toBe(init.sessionId);
    expect(result.costUsd ?? -1).toBeGreaterThanOrEqual(0);
    const usage = Object.values(result.usageByModel).find(
      (u) => u.inputTokens > 0,
    );
    expect(usage).toBeDefined();
  }, 10_000);
});
