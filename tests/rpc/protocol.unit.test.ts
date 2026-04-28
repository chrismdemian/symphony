import { describe, expect, it } from 'vitest';
import {
  decodeFrame,
  encodeFrame,
  ProtocolError,
  ok,
  err,
  type Frame,
} from '../../src/rpc/protocol.js';

describe('rpc/protocol — frame round-trip', () => {
  it('round-trips an rpc-call frame', () => {
    const frame: Frame = {
      kind: 'rpc-call',
      id: 'abc',
      namespace: 'projects',
      procedure: 'list',
      args: [{ nameContains: 'foo' }],
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it('round-trips an rpc-result success envelope', () => {
    const frame: Frame = {
      kind: 'rpc-result',
      id: 'abc',
      result: { success: true, data: { count: 3 } },
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it('round-trips an rpc-result failure envelope', () => {
    const frame: Frame = {
      kind: 'rpc-result',
      id: 'abc',
      result: { success: false, error: { code: 'not_found', message: 'missing' } },
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it('round-trips a subscribe frame with structured args', () => {
    const frame: Frame = {
      kind: 'subscribe',
      id: 's1',
      topic: 'workers.events',
      args: { workerId: 'wk-1' },
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it('round-trips an unsubscribe frame', () => {
    const frame: Frame = {
      kind: 'unsubscribe',
      id: 's1',
      topic: 'workers.events:wk-1',
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it('round-trips an event frame', () => {
    const frame: Frame = {
      kind: 'event',
      topic: 'workers.events:wk-1',
      payload: { type: 'assistant_text', text: 'hi' },
    };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });
});

describe('rpc/protocol — decode rejects malformed input', () => {
  it('throws ProtocolError on non-JSON', () => {
    expect(() => decodeFrame('not json')).toThrowError(ProtocolError);
  });

  it('throws when frame is not an object', () => {
    expect(() => decodeFrame('"a string"')).toThrowError(/object/);
  });

  it('throws on unknown kind', () => {
    expect(() => decodeFrame(JSON.stringify({ kind: 'bogus' }))).toThrowError(/unknown frame kind/);
  });

  it('throws when rpc-call is missing required fields', () => {
    expect(() => decodeFrame(JSON.stringify({ kind: 'rpc-call', id: 'a' }))).toThrowError();
  });

  it('throws when rpc-call.args is not an array', () => {
    expect(() =>
      decodeFrame(
        JSON.stringify({ kind: 'rpc-call', id: 'a', namespace: 'p', procedure: 'q', args: {} }),
      ),
    ).toThrowError(/args must be an array/);
  });

  it('throws when rpc-result.success is neither true nor false', () => {
    expect(() =>
      decodeFrame(JSON.stringify({ kind: 'rpc-result', id: 'a', result: { success: 'maybe' } })),
    ).toThrowError(/success must be true or false/);
  });

  it('throws when rpc-result.error lacks code+message strings', () => {
    expect(() =>
      decodeFrame(
        JSON.stringify({
          kind: 'rpc-result',
          id: 'a',
          result: { success: false, error: { code: 'x' } },
        }),
      ),
    ).toThrowError();
  });

  it('throws when frame.id is empty', () => {
    expect(() =>
      decodeFrame(JSON.stringify({ kind: 'rpc-call', id: '', namespace: 'p', procedure: 'q', args: [] })),
    ).toThrowError(/non-empty/);
  });
});

describe('rpc/protocol — envelope helpers', () => {
  it('ok wraps data', () => {
    expect(ok(42)).toEqual({ success: true, data: 42 });
  });

  it('err wraps code+message', () => {
    expect(err('not_found', 'missing')).toEqual({
      success: false,
      error: { code: 'not_found', message: 'missing' },
    });
  });
});
