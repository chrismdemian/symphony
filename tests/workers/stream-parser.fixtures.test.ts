import { describe, it, expect } from 'vitest';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseStream } from '../../src/workers/stream-parser.js';
import type { StreamEvent } from '../../src/workers/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, '..', 'fixtures', 'stream-json');

async function readAll(file: string): Promise<StreamEvent[]> {
  const stream = createReadStream(join(fixtures, file));
  const out: StreamEvent[] = [];
  for await (const ev of parseStream(stream)) out.push(ev);
  return out;
}

describe('parseStream fixtures', () => {
  it('happy-path: init → text → result', async () => {
    const events = await readAll('happy-path.ndjson');
    const types = events.map((e) => e.type);
    expect(types).toEqual(['system_init', 'assistant_text', 'result']);

    const init = events[0];
    if (init?.type === 'system_init') {
      expect(init.sessionId).toBe('00000000-0000-4000-8000-000000000001');
      expect(init.model).toBe('claude-opus-4-7');
      expect(init.tools).toEqual(['Read', 'Write', 'Bash']);
      expect(init.mcpServers).toEqual([{ name: 'symphony', status: 'connected' }]);
    } else throw new Error('expected system_init first');

    const result = events[2];
    if (result?.type === 'result') {
      expect(result.costUsd).toBe(0.00182);
      expect(result.numTurns).toBe(1);
      expect(result.usageByModel['claude-opus-4-7']).toEqual({
        inputTokens: 125,
        outputTokens: 18,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    } else throw new Error('expected result last');
  });

  it('tool-use-turn: tool call → result → follow-up → final', async () => {
    const events = await readAll('tool-use-turn.ndjson');
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'system_init',
      'assistant_text',
      'tool_use',
      'tool_result',
      'assistant_text',
      'result',
    ]);

    const tool = events[2];
    if (tool?.type === 'tool_use') {
      expect(tool.name).toBe('Bash');
      expect(tool.callId).toBe('call-abc');
      expect(tool.input).toEqual({ command: 'ls -la' });
    }

    const toolResult = events[3];
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.callId).toBe('call-abc');
      expect(toolResult.isError).toBe(false);
      expect(toolResult.content).toContain('total 4');
    }

    const result = events[5];
    if (result?.type === 'result') {
      expect(result.usageByModel['claude-opus-4-7']).toEqual({
        inputTokens: 420,
        outputTokens: 42,
        cacheReadTokens: 2050,
        cacheWriteTokens: 50,
      });
    }
  });

  it('api-retry: multiple retry events before completion', async () => {
    const events = await readAll('api-retry.ndjson');
    const retries = events.filter((e) => e.type === 'system_api_retry');
    expect(retries).toHaveLength(2);
    if (retries[0]?.type === 'system_api_retry') {
      expect(retries[0].attempt).toBe(1);
      expect(retries[0].delayMs).toBe(2000);
    }
    expect(events[events.length - 1]?.type).toBe('result');
  });

  it('malformed-mixed: bad lines and unknown types become parse_error, stream recovers', async () => {
    const events = await readAll('malformed-mixed.ndjson');
    const parseErrors = events.filter((e) => e.type === 'parse_error');
    expect(parseErrors.length).toBe(2);
    expect(parseErrors[0]?.type).toBe('parse_error');
    if (parseErrors[0]?.type === 'parse_error') {
      expect(parseErrors[0].reason.toLowerCase()).toContain('json');
    }
    if (parseErrors[1]?.type === 'parse_error') {
      expect(parseErrors[1].reason).toContain('unknown event type');
    }
    expect(events.find((e) => e.type === 'assistant_text')).toBeDefined();
    expect(events[events.length - 1]?.type).toBe('result');
  });

  it('structured-completion: emits structured_completion event alongside assistant_text', async () => {
    const events = await readAll('structured-completion.ndjson');
    const structured = events.find((e) => e.type === 'structured_completion');
    expect(structured).toBeDefined();
    if (structured?.type === 'structured_completion') {
      expect(structured.report.audit).toBe('PASS');
      expect(structured.report.did).toEqual([
        'extracted helper function',
        'added tests',
      ]);
      expect(structured.report.open_questions).toEqual(['consider renaming foo()']);
      expect(structured.report.cite).toEqual([
        'src/foo.ts:42',
        'tests/foo.test.ts:10',
      ]);
      expect(structured.report.preview_url).toBeNull();
    }
    // The assistant_text event is still emitted even when a completion report is found.
    expect(events.find((e) => e.type === 'assistant_text')).toBeDefined();
  });
});
