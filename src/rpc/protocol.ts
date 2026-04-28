/**
 * Symphony WS-RPC wire protocol — Phase 2B.2.
 *
 * Frames are JSON-encoded and travel as WebSocket text messages, one frame
 * per message. The protocol carries three concerns over one socket:
 *
 *   1. Request/response RPC (`rpc-call` → `rpc-result`)
 *   2. Subscriptions (`subscribe` / `unsubscribe`, both ack as `rpc-result`)
 *   3. Server-pushed events (`event`, no client ack)
 *
 * Result envelope is `{ success: true, data } | { success: false, error }`,
 * lifted verbatim from emdash (`agents/conventions/ipc.md`). Errors carry a
 * stable `code` enum so clients can branch without regex over `message`.
 */

export const PROTOCOL_VERSION = 1 as const;

/**
 * Hard cap on inbound frame size. Bounds `JSON.parse` cost so a
 * token-bearing client cannot OOM the orchestrator with a 100MB blob
 * (Audit M2). 1 MiB is generous for any RPC envelope today; large
 * payloads should travel as multi-frame events, not single frames.
 */
export const MAX_FRAME_BYTES = 1 * 1024 * 1024;

export type ErrorCode =
  | 'not_found'
  | 'bad_args'
  | 'unauthorized'
  | 'internal'
  | 'aborted'
  | 'subscription_failed';

export interface RpcError {
  readonly code: ErrorCode;
  readonly message: string;
}

export type RpcEnvelope =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: RpcError };

export interface RpcCallFrame {
  readonly kind: 'rpc-call';
  readonly id: string;
  readonly namespace: string;
  readonly procedure: string;
  readonly args: readonly unknown[];
}

export interface RpcResultFrame {
  readonly kind: 'rpc-result';
  readonly id: string;
  readonly result: RpcEnvelope;
}

export interface SubscribeFrame {
  readonly kind: 'subscribe';
  readonly id: string;
  readonly topic: string;
  readonly args: unknown;
}

export interface UnsubscribeFrame {
  readonly kind: 'unsubscribe';
  readonly id: string;
  readonly topic: string;
}

export interface EventFrame {
  readonly kind: 'event';
  readonly topic: string;
  readonly payload: unknown;
}

export type Frame =
  | RpcCallFrame
  | RpcResultFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | EventFrame;

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

const FRAME_KINDS = new Set(['rpc-call', 'rpc-result', 'subscribe', 'unsubscribe', 'event']);

/**
 * Decode a wire-format frame from a JSON string. Throws `ProtocolError`
 * with code `bad_args` on any structural problem — callers convert that
 * into either a 1008 close (server-side) or a rejected promise
 * (client-side). Returns a typed `Frame`.
 */
export function decodeFrame(text: string): Frame {
  if (text.length > MAX_FRAME_BYTES) {
    throw new ProtocolError(
      'bad_args',
      `frame exceeds ${MAX_FRAME_BYTES}-byte limit (got ${text.length})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProtocolError('bad_args', 'frame is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new ProtocolError('bad_args', 'frame must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj['kind'];
  if (typeof kind !== 'string' || !FRAME_KINDS.has(kind)) {
    throw new ProtocolError('bad_args', `unknown frame kind '${String(kind)}'`);
  }
  switch (kind) {
    case 'rpc-call':
      return decodeCallFrame(obj);
    case 'rpc-result':
      return decodeResultFrame(obj);
    case 'subscribe':
      return decodeSubscribeFrame(obj);
    case 'unsubscribe':
      return decodeUnsubscribeFrame(obj);
    case 'event':
      return decodeEventFrame(obj);
    default:
      throw new ProtocolError('bad_args', `unreachable frame kind '${kind}'`);
  }
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

export function ok(data: unknown): RpcEnvelope {
  return { success: true, data };
}

export function err(code: ErrorCode, message: string): RpcEnvelope {
  return { success: false, error: { code, message } };
}

function decodeCallFrame(obj: Record<string, unknown>): RpcCallFrame {
  const id = requireString(obj, 'id');
  const namespace = requireString(obj, 'namespace');
  const procedure = requireString(obj, 'procedure');
  const args = obj['args'];
  if (!Array.isArray(args)) {
    throw new ProtocolError('bad_args', 'rpc-call.args must be an array');
  }
  return { kind: 'rpc-call', id, namespace, procedure, args };
}

function decodeResultFrame(obj: Record<string, unknown>): RpcResultFrame {
  const id = requireString(obj, 'id');
  const rawResult = obj['result'];
  if (typeof rawResult !== 'object' || rawResult === null) {
    throw new ProtocolError('bad_args', 'rpc-result.result must be an object');
  }
  const env = rawResult as Record<string, unknown>;
  if (env['success'] === true) {
    return { kind: 'rpc-result', id, result: { success: true, data: env['data'] } };
  }
  if (env['success'] === false) {
    const errVal = env['error'];
    if (typeof errVal !== 'object' || errVal === null) {
      throw new ProtocolError('bad_args', 'rpc-result.error must be an object');
    }
    const e = errVal as Record<string, unknown>;
    const code = e['code'];
    const message = e['message'];
    if (typeof code !== 'string' || typeof message !== 'string') {
      throw new ProtocolError('bad_args', 'rpc-result.error must carry code+message strings');
    }
    return {
      kind: 'rpc-result',
      id,
      result: { success: false, error: { code: code as ErrorCode, message } },
    };
  }
  throw new ProtocolError('bad_args', 'rpc-result.success must be true or false');
}

function decodeSubscribeFrame(obj: Record<string, unknown>): SubscribeFrame {
  const id = requireString(obj, 'id');
  const topic = requireString(obj, 'topic');
  return { kind: 'subscribe', id, topic, args: obj['args'] };
}

function decodeUnsubscribeFrame(obj: Record<string, unknown>): UnsubscribeFrame {
  const id = requireString(obj, 'id');
  const topic = requireString(obj, 'topic');
  return { kind: 'unsubscribe', id, topic };
}

function decodeEventFrame(obj: Record<string, unknown>): EventFrame {
  const topic = requireString(obj, 'topic');
  return { kind: 'event', topic, payload: obj['payload'] };
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ProtocolError('bad_args', `frame.${key} must be a non-empty string`);
  }
  return v;
}
