import { describe, it, expect } from 'vitest';
import { parseStream } from '../../src/workers/stream-parser.js';
import type { StreamEvent } from '../../src/workers/types.js';

async function* feed(...lines: Array<string | object>): AsyncIterable<string> {
  for (const l of lines) {
    if (typeof l === 'string') yield l + '\n';
    else yield JSON.stringify(l) + '\n';
  }
}

async function collect(source: AsyncIterable<string>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of parseStream(source)) out.push(ev);
  return out;
}

function assistantTurn(content: unknown[], opts: { model?: string; usage?: unknown } = {}) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: opts.model,
      content,
      usage: opts.usage,
    },
  };
}

function userTurn(content: unknown[]) {
  return {
    type: 'user',
    message: { role: 'user', content },
  };
}

const validReportBody = {
  did: ['x'],
  skipped: [],
  blockers: [],
  open_questions: [],
  audit: 'PASS',
  cite: ['a:1'],
  tests_run: ['pnpm test: ok'],
  preview_url: null,
};

describe('parseStream', () => {
  it('captures session id from system/init', async () => {
    const events = await collect(
      feed({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-123',
        cwd: '/tmp/x',
        model: 'claude-opus',
        tools: ['Bash', 'Read'],
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'system_init',
      sessionId: 'sess-123',
      cwd: '/tmp/x',
      model: 'claude-opus',
      tools: ['Bash', 'Read'],
      mcpServers: undefined,
    });
  });

  it('emits system_api_retry for api_retry subtype', async () => {
    const events = await collect(
      feed({ type: 'system', subtype: 'api_retry', attempt: 2, delay_ms: 1500 }),
    );
    expect(events[0]?.type).toBe('system_api_retry');
    if (events[0]?.type === 'system_api_retry') {
      expect(events[0].attempt).toBe(2);
      expect(events[0].delayMs).toBe(1500);
    }
  });

  it('emits assistant_text from a text block', async () => {
    const events = await collect(
      feed(assistantTurn([{ type: 'text', text: 'Hello' }], { model: 'claude-opus' })),
    );
    const textEvent = events.find((e) => e.type === 'assistant_text');
    expect(textEvent).toBeDefined();
    if (textEvent?.type === 'assistant_text') {
      expect(textEvent.text).toBe('Hello');
      expect(textEvent.model).toBe('claude-opus');
    }
  });

  it('emits assistant_thinking from a thinking block', async () => {
    const events = await collect(
      feed(assistantTurn([{ type: 'thinking', text: 'musing...' }])),
    );
    expect(events.find((e) => e.type === 'assistant_thinking')).toBeDefined();
  });

  it('emits tool_use from a tool_use block with input', async () => {
    const events = await collect(
      feed(
        assistantTurn([
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ]),
      ),
    );
    const toolUse = events.find((e) => e.type === 'tool_use');
    expect(toolUse).toEqual({
      type: 'tool_use',
      callId: 'call-1',
      name: 'Bash',
      input: { command: 'ls' },
    });
  });

  it('emits all three block types from a mixed assistant turn in order', async () => {
    const events = await collect(
      feed(
        assistantTurn([
          { type: 'text', text: 'Let me think.' },
          { type: 'thinking', text: 'thought' },
          { type: 'tool_use', id: 'c1', name: 'Read', input: { path: '/x' } },
        ]),
      ),
    );
    const types = events.map((e) => e.type);
    expect(types).toEqual(['assistant_text', 'assistant_thinking', 'tool_use']);
  });

  it('emits tool_result from a user turn', async () => {
    const events = await collect(
      feed(
        userTurn([
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: 'stdout',
            is_error: false,
          },
        ]),
      ),
    );
    expect(events).toEqual([
      { type: 'tool_result', callId: 'call-1', content: 'stdout', isError: false },
    ]);
  });

  it('flattens array-shaped tool_result content into joined text', async () => {
    const events = await collect(
      feed(
        userTurn([
          {
            type: 'tool_result',
            tool_use_id: 'c1',
            content: [
              { type: 'text', text: 'part1 ' },
              { type: 'text', text: 'part2' },
            ],
          },
        ]),
      ),
    );
    expect(events[0]?.type).toBe('tool_result');
    if (events[0]?.type === 'tool_result') {
      expect(events[0].content).toBe('part1 part2');
      expect(events[0].isError).toBe(false);
    }
  });

  it('propagates is_error on tool_result', async () => {
    const events = await collect(
      feed(
        userTurn([
          { type: 'tool_result', tool_use_id: 'c1', content: 'oops', is_error: true },
        ]),
      ),
    );
    if (events[0]?.type === 'tool_result') expect(events[0].isError).toBe(true);
  });

  it('accumulates per-model token usage across assistant turns', async () => {
    const events = await collect(
      feed(
        assistantTurn([{ type: 'text', text: 'a' }], {
          model: 'claude-opus',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 2,
          },
        }),
        assistantTurn([{ type: 'text', text: 'b' }], {
          model: 'claude-opus',
          usage: {
            input_tokens: 20,
            output_tokens: 15,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4,
          },
        }),
        assistantTurn([{ type: 'text', text: 'c' }], {
          model: 'claude-sonnet',
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
          session_id: 'sess-9',
          duration_ms: 1234,
          num_turns: 3,
          total_cost_usd: 0.0042,
        },
      ),
    );
    const result = events.find((e) => e.type === 'result');
    expect(result).toBeDefined();
    if (result?.type === 'result') {
      expect(result.sessionId).toBe('sess-9');
      expect(result.resultText).toBe('done');
      expect(result.durationMs).toBe(1234);
      expect(result.numTurns).toBe(3);
      expect(result.costUsd).toBe(0.0042);
      expect(result.usageByModel['claude-opus']).toEqual({
        inputTokens: 30,
        outputTokens: 20,
        cacheReadTokens: 4,
        cacheWriteTokens: 6,
      });
      expect(result.usageByModel['claude-sonnet']).toEqual({
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    }
  });

  it('emits control_request but never writes (parser is read-only)', async () => {
    const events = await collect(
      feed({
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'tool_use',
          tool_name: 'Bash',
          input: { command: 'ls' },
        },
      }),
    );
    expect(events[0]).toEqual({
      type: 'control_request',
      requestId: 'req-1',
      subtype: 'tool_use',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
  });

  it('emits log events', async () => {
    const events = await collect(
      feed({ type: 'log', log: { level: 'warn', message: 'throttled' } }),
    );
    expect(events[0]).toEqual({ type: 'log', level: 'warn', message: 'throttled' });
  });

  it('skips malformed JSON lines with parse_error and keeps going', async () => {
    const events: StreamEvent[] = [];
    async function* src(): AsyncIterable<string> {
      yield '{not json}\n';
      yield JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\n';
    }
    for await (const ev of parseStream(src())) events.push(ev);
    expect(events[0]?.type).toBe('parse_error');
    expect(events[1]?.type).toBe('system_init');
  });

  it('flags unknown event types as parse_error', async () => {
    const events = await collect(feed({ type: 'mystery', foo: 1 }));
    expect(events[0]?.type).toBe('parse_error');
    if (events[0]?.type === 'parse_error') {
      expect(events[0].reason).toContain('unknown event type');
    }
  });

  it('detects a valid structured completion in assistant text', async () => {
    const text = 'done.\n\n```json\n' + JSON.stringify(validReportBody) + '\n```';
    const events = await collect(feed(assistantTurn([{ type: 'text', text }])));
    const structured = events.find((e) => e.type === 'structured_completion');
    expect(structured).toBeDefined();
    if (structured?.type === 'structured_completion') {
      expect(structured.report.audit).toBe('PASS');
      expect(structured.report.did).toEqual(['x']);
    }
  });

  it('emits parse_error for a completion fence with invalid shape', async () => {
    const bad = { ...validReportBody, audit: 'MAYBE' };
    const text = '```json\n' + JSON.stringify(bad) + '\n```';
    const events = await collect(feed(assistantTurn([{ type: 'text', text }])));
    expect(events.find((e) => e.type === 'assistant_text')).toBeDefined();
    const err = events.find((e) => e.type === 'parse_error');
    expect(err).toBeDefined();
    if (err?.type === 'parse_error') {
      expect(err.reason).toContain('audit');
    }
  });

  it('emits system for other subtypes', async () => {
    const events = await collect(
      feed({ type: 'system', subtype: 'compact', session_id: 'sess-2' }),
    );
    expect(events[0]?.type).toBe('system');
    if (events[0]?.type === 'system') {
      expect(events[0].subtype).toBe('compact');
      expect(events[0].sessionId).toBe('sess-2');
    }
  });

  it('flags system/init missing session_id as parse_error', async () => {
    const events = await collect(feed({ type: 'system', subtype: 'init' }));
    expect(events[0]?.type).toBe('parse_error');
  });

  it('skips blank lines and continues', async () => {
    async function* src(): AsyncIterable<string> {
      yield '\n\n';
      yield JSON.stringify({ type: 'log', log: { level: 'info', message: 'hi' } }) + '\n';
    }
    const events: StreamEvent[] = [];
    for await (const ev of parseStream(src())) events.push(ev);
    expect(events).toEqual([{ type: 'log', level: 'info', message: 'hi' }]);
  });

  it('emits parse_error for over_cap lines and recovers on the next line', async () => {
    const logLine = JSON.stringify({
      type: 'log',
      log: { level: 'info', message: 'ok' },
    });
    async function* src(): AsyncIterable<string> {
      yield 'x'.repeat(logLine.length * 4) + '\n';
      yield logLine + '\n';
    }
    const events: StreamEvent[] = [];
    for await (const ev of parseStream(src(), { maxLineBytes: logLine.length + 1 }))
      events.push(ev);
    expect(events[0]?.type).toBe('parse_error');
    expect(events[1]?.type).toBe('log');
  });

  it('accepts string-encoded message payloads on assistant events', async () => {
    const encoded = JSON.stringify({
      role: 'assistant',
      content: [{ type: 'text', text: 'nested' }],
    });
    const events = await collect(feed({ type: 'assistant', message: encoded }));
    expect(events.find((e) => e.type === 'assistant_text')).toBeDefined();
  });

  it('result event exposes cumulative session usage as a top-level sessionUsage field', async () => {
    const events = await collect(
      feed({
        type: 'result',
        is_error: false,
        result: 'ok',
        session_id: 's1',
        duration_ms: 10,
        num_turns: 1,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    );
    expect(events[0]?.type).toBe('result');
    if (events[0]?.type === 'result') {
      expect(events[0].sessionUsage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      // sessionUsage lives alongside (not inside) usageByModel, so consumers
      // summing per-model totals never double-count the CLI's cumulative roll-up.
      expect(events[0].usageByModel).not.toHaveProperty('__session__');
    }
  });

  it('emits parse_error when result is missing session_id', async () => {
    const events = await collect(
      feed({ type: 'result', is_error: false, result: 'ok', duration_ms: 1, num_turns: 1 }),
    );
    expect(events[0]?.type).toBe('parse_error');
    if (events[0]?.type === 'parse_error') {
      expect(events[0].reason).toContain('session_id');
    }
  });

  it('propagates isError=true on result', async () => {
    const events = await collect(
      feed({
        type: 'result',
        is_error: true,
        result: 'rate limited',
        session_id: 'sess-err',
        duration_ms: 5000,
        num_turns: 2,
      }),
    );
    expect(events[0]?.type).toBe('result');
    if (events[0]?.type === 'result') {
      expect(events[0].isError).toBe(true);
      expect(events[0].resultText).toBe('rate limited');
      expect(events[0].sessionId).toBe('sess-err');
    }
  });

  it('silently skips stream_event delta events (deferred for v1)', async () => {
    const events = await collect(
      feed(
        { type: 'stream_event', event: { type: 'content_block_delta' } },
        { type: 'log', log: { level: 'info', message: 'ok' } },
      ),
    );
    expect(events).toEqual([{ type: 'log', level: 'info', message: 'ok' }]);
  });

  it('strips mid-stream BOM before dispatching', async () => {
    const logLine = JSON.stringify({
      type: 'log',
      log: { level: 'info', message: 'hi' },
    });
    async function* src(): AsyncIterable<Buffer> {
      yield Buffer.from(logLine + '\n', 'utf8');
      // Second chunk begins with a BOM — must not break the next line's JSON parse.
      yield Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(logLine + '\n', 'utf8')]);
    }
    const events: StreamEvent[] = [];
    for await (const ev of parseStream(src())) events.push(ev);
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe('log');
    expect(events[1]?.type).toBe('log');
  });
});
