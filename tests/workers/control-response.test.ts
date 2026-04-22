import { describe, it, expect } from 'vitest';
import { buildControlResponse, encodeControlResponse } from '../../src/workers/control-response.js';
import type { ControlRequestEvent } from '../../src/workers/types.js';

function makeRequest(over: Partial<ControlRequestEvent> = {}): ControlRequestEvent {
  return {
    type: 'control_request',
    requestId: 'req-1',
    subtype: 'can_use_tool',
    toolName: 'Bash',
    input: { command: 'ls' },
    ...over,
  };
}

describe('buildControlResponse', () => {
  it('emits the double-nested shape Multica uses verbatim', () => {
    const req = makeRequest();
    expect(buildControlResponse(req)).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'ls' },
        },
      },
    });
  });

  it('passes through empty input objects', () => {
    const payload = buildControlResponse(makeRequest({ input: {} }));
    expect(payload.response.response.updatedInput).toEqual({});
  });

  it('echoes the request id unchanged', () => {
    const payload = buildControlResponse(makeRequest({ requestId: 'abc-xyz-42' }));
    expect(payload.response.request_id).toBe('abc-xyz-42');
  });

  it('preserves input structure (nested objects, arrays)', () => {
    const req = makeRequest({
      input: {
        command: 'git',
        args: ['status', '-s'],
        options: { cwd: '/tmp', env: { FOO: '1' } },
      },
    });
    const payload = buildControlResponse(req);
    expect(payload.response.response.updatedInput).toEqual(req.input);
  });

  it('always sets behavior to "allow" and subtype to "success"', () => {
    const payload = buildControlResponse(makeRequest({ toolName: 'Write' }));
    expect(payload.response.subtype).toBe('success');
    expect(payload.response.response.behavior).toBe('allow');
  });
});

describe('encodeControlResponse', () => {
  it('serializes with trailing newline for NDJSON', () => {
    const text = encodeControlResponse(makeRequest());
    expect(text.endsWith('\n')).toBe(true);
    expect(text.slice(0, -1)).toBe(JSON.stringify(buildControlResponse(makeRequest())));
  });

  it('round-trips through JSON.parse preserving shape', () => {
    const text = encodeControlResponse(makeRequest({ input: { a: 1, b: [true, null] } }));
    const parsed: unknown = JSON.parse(text.trim());
    expect(parsed).toEqual(buildControlResponse(makeRequest({ input: { a: 1, b: [true, null] } })));
  });
});
