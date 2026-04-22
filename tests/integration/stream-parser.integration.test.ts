import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseStream } from '../../src/workers/stream-parser.js';
import type { StreamEvent } from '../../src/workers/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fakeClaude = join(__dirname, '..', 'helpers', 'fake-claude.mjs');

interface RunResult {
  events: StreamEvent[];
  exitCode: number | null;
  stderr: string;
}

async function runFakeClaude(fixture: string, delayMs = 0): Promise<RunResult> {
  const args = [fakeClaude, fixture];
  if (delayMs > 0) args.push(`--delay-ms=${delayMs}`);
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

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

describe('parseStream integration (fake-claude subprocess)', () => {
  it('parses a happy-path session end-to-end', async () => {
    const { events, exitCode, stderr } = await runFakeClaude('happy-path');
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(events.map((e) => e.type)).toEqual([
      'system_init',
      'assistant_text',
      'result',
    ]);
    const init = events[0];
    const result = events[2];
    if (init?.type === 'system_init' && result?.type === 'result') {
      expect(init.sessionId).toBe(result.sessionId);
    }
  }, 10_000);

  it('parses a tool-use session with full round-trip', async () => {
    const { events, exitCode } = await runFakeClaude('tool-use-turn');
    expect(exitCode).toBe(0);
    expect(events.map((e) => e.type)).toEqual([
      'system_init',
      'assistant_text',
      'tool_use',
      'tool_result',
      'assistant_text',
      'result',
    ]);
  }, 10_000);

  it('survives chunked delivery (per-line 15ms delay)', async () => {
    const { events, exitCode } = await runFakeClaude('tool-use-turn', 15);
    expect(exitCode).toBe(0);
    expect(events.map((e) => e.type)).toEqual([
      'system_init',
      'assistant_text',
      'tool_use',
      'tool_result',
      'assistant_text',
      'result',
    ]);
  }, 15_000);

  it('keeps streaming past a malformed line', async () => {
    const { events, exitCode } = await runFakeClaude('malformed-mixed');
    expect(exitCode).toBe(0);
    expect(events.filter((e) => e.type === 'parse_error').length).toBeGreaterThan(0);
    expect(events.find((e) => e.type === 'assistant_text')).toBeDefined();
    expect(events[events.length - 1]?.type).toBe('result');
  }, 10_000);
});
