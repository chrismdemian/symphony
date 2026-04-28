import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  EventFrame,
  Frame,
  RpcCallFrame,
  RpcEnvelope,
  SubscribeFrame,
  UnsubscribeFrame,
} from './protocol.js';
import { ProtocolError, decodeFrame, encodeFrame, err, ok } from './protocol.js';
import { resolveProcedure } from './router.js';
import type { WorkerEventBroker } from './event-broker.js';

/**
 * Per-connection dispatcher — Phase 2B.2.
 *
 * Owns the message loop for a single WebSocket. Decodes frames, looks up
 * procedures on the router, threads the connection's `AbortSignal` into
 * handlers, and writes envelopes back. Subscriptions are tracked here so a
 * single `close()` call tears down everything the connection registered.
 *
 * The dispatcher does NOT own the WS object — the server does. This file
 * is transport-agnostic except for the `send` callback the server passes
 * in. Easier to test in isolation than the full WS plumbing.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouterMap = Record<string, Record<string, (...args: any[]) => unknown>>;

export interface DispatcherSendOptions {
  /** Drop the message instead of throwing if the WS send buffer is saturated. */
  readonly dropOnBackpressure?: boolean;
}

export type DispatcherSend = (
  text: string,
  options?: DispatcherSendOptions,
) => void;

export type DispatcherProtocolViolationCloser = (code: number, reason: string) => void;

export interface DispatcherOptions {
  readonly router: RouterMap;
  readonly broker: WorkerEventBroker;
  readonly send: DispatcherSend;
  /** Aborts when the underlying connection closes. Threads into handlers. */
  readonly signal: AbortSignal;
  /**
   * Audit m11: close the WS on illegal-direction frames. The dispatcher
   * doesn't own the WS — the server passes a closer. Default: no-op
   * (pure unit-test mode).
   */
  readonly closeOnProtocolError?: DispatcherProtocolViolationCloser;
}

interface SubscriptionEntry {
  readonly topic: string;
  readonly unsubscribe: () => void;
}

const WORKERS_EVENTS_TOPIC = 'workers.events' as const;

export class Dispatcher {
  private readonly router: RouterMap;
  private readonly broker: WorkerEventBroker;
  private readonly send: DispatcherSend;
  private readonly signal: AbortSignal;
  private readonly closeOnProtocolError: DispatcherProtocolViolationCloser;
  private readonly subscriptions = new Map<string, SubscriptionEntry>();
  private closed = false;

  constructor(opts: DispatcherOptions) {
    this.router = opts.router;
    this.broker = opts.broker;
    this.send = opts.send;
    this.signal = opts.signal;
    this.closeOnProtocolError = opts.closeOnProtocolError ?? (() => {});
  }

  /**
   * Handle a raw inbound text frame. Errors at the protocol layer are
   * logged and reflected back as a result envelope when an `id` is
   * available; truly unrecoverable frames close the connection.
   */
  async handle(rawText: string): Promise<void> {
    if (this.closed) return;
    let frame: Frame;
    try {
      frame = decodeFrame(rawText);
    } catch (cause) {
      const message =
        cause instanceof ProtocolError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : 'frame decode failed';
      // Without a frame.id we cannot reply with a typed envelope; emit a
      // synthetic envelope under id="<unknown>" so the client at least
      // observes the failure.
      this.sendResult('<unknown>', err('bad_args', message));
      return;
    }
    switch (frame.kind) {
      case 'rpc-call':
        await this.handleCall(frame);
        return;
      case 'subscribe':
        this.handleSubscribe(frame);
        return;
      case 'unsubscribe':
        this.handleUnsubscribe(frame);
        return;
      case 'rpc-result':
      case 'event':
        // Audit m11: illegal-direction frames close the connection with
        // WS code 1002 (protocol error) rather than reply with a result
        // envelope. A persistent malicious client doesn't get to keep
        // burning server cycles on bad frames.
        this.closeOnProtocolError(
          1002,
          `frame kind '${frame.kind}' is not valid in client→server direction`,
        );
        return;
    }
  }

  /** Tear down all subscriptions registered by this connection. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.subscriptions.values()) {
      try {
        entry.unsubscribe();
      } catch {
        // Listener removal must not throw.
      }
    }
    this.subscriptions.clear();
  }

  private async handleCall(frame: RpcCallFrame): Promise<void> {
    const handler = resolveProcedure(this.router, frame.namespace, frame.procedure);
    if (handler === undefined) {
      this.sendResult(
        frame.id,
        err('not_found', `procedure '${frame.namespace}.${frame.procedure}' is not registered`),
      );
      return;
    }
    try {
      // Handlers may opt into the connection's signal by accepting it as a
      // trailing argument shape `(...args, ctx)`. To keep the surface
      // simple in 2B.2, we expose `signal` via a thread-local construct
      // ONLY through `wrapProcedure` (router-impl). Calls dispatched here
      // pass the args verbatim — handlers that need cancellation read
      // from `getCurrentSignal()` (see router-impl).
      const result = await invokeWithSignal(handler, frame.args, this.signal);
      this.sendResult(frame.id, ok(result));
    } catch (cause) {
      const envelope = errorToEnvelope(cause, this.signal.aborted);
      this.sendResult(frame.id, envelope);
    }
  }

  private handleSubscribe(frame: SubscribeFrame): void {
    if (this.subscriptions.has(frame.id)) {
      this.sendResult(frame.id, err('bad_args', `subscription id '${frame.id}' already in use`));
      return;
    }
    if (frame.topic !== WORKERS_EVENTS_TOPIC) {
      this.sendResult(
        frame.id,
        err('not_found', `subscription topic '${frame.topic}' is not supported`),
      );
      return;
    }
    const args = frame.args;
    if (
      typeof args !== 'object' ||
      args === null ||
      typeof (args as Record<string, unknown>)['workerId'] !== 'string'
    ) {
      this.sendResult(
        frame.id,
        err('bad_args', `subscribe ${WORKERS_EVENTS_TOPIC} requires { workerId: string }`),
      );
      return;
    }
    const workerId = (args as { workerId: string }).workerId;
    if (workerId.length === 0) {
      this.sendResult(frame.id, err('bad_args', 'workerId must be a non-empty string'));
      return;
    }
    const eventTopic = `${WORKERS_EVENTS_TOPIC}:${workerId}`;
    const unsubscribe = this.broker.subscribe(workerId, (event) => {
      const out: EventFrame = { kind: 'event', topic: eventTopic, payload: event };
      // Per-event back-pressure protection — drop on saturation rather
      // than queueing infinitely. A subscriber that can't keep up loses
      // events; we never block the broker.
      this.send(encodeFrame(out), { dropOnBackpressure: true });
    });
    this.subscriptions.set(frame.id, { topic: eventTopic, unsubscribe });
    this.sendResult(frame.id, ok({ topic: eventTopic }));
  }

  private handleUnsubscribe(frame: UnsubscribeFrame): void {
    const entry = this.subscriptions.get(frame.id);
    if (!entry) {
      this.sendResult(frame.id, err('not_found', `subscription id '${frame.id}' is not active`));
      return;
    }
    entry.unsubscribe();
    this.subscriptions.delete(frame.id);
    this.sendResult(frame.id, ok({ unsubscribed: entry.topic }));
  }

  private sendResult(id: string, result: RpcEnvelope): void {
    const frame: Frame = { kind: 'rpc-result', id, result };
    this.send(encodeFrame(frame));
  }
}

/**
 * AsyncLocalStorage-backed signal threading. Audit C1 (2B.2 review):
 * a module-local `let CURRENT_SIGNAL` interleaves on `await` boundaries
 * across concurrent async invocations and silently delivers the wrong
 * signal to procedures that resume after another invocation has reset
 * the global. AsyncLocalStorage is purpose-built for this — it tracks
 * the value across `await` via V8's promise hooks.
 *
 * Today every `router-impl.ts` procedure is sync; the broken pattern
 * was unreachable. Phase 3+ async procedures (waves, long-polling,
 * reducer fan-in) will absolutely hit this path.
 */
const signalStorage = new AsyncLocalStorage<AbortSignal>();

export function getCurrentSignal(): AbortSignal | undefined {
  return signalStorage.getStore();
}

async function invokeWithSignal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => unknown,
  args: readonly unknown[],
  signal: AbortSignal,
): Promise<unknown> {
  return signalStorage.run(signal, () => Promise.resolve(handler(...args)));
}

function errorToEnvelope(cause: unknown, aborted: boolean): RpcEnvelope {
  if (aborted) {
    return err('aborted', 'connection closed before result');
  }
  if (cause instanceof ProtocolError) {
    return err(cause.code, cause.message);
  }
  // Duck-type detection for procedure-level errors that carry a typed
  // `code` field (e.g. router-impl.ts's `RpcArgError`). Any Error subclass
  // with a `code: ErrorCode` is treated as user-facing.
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && KNOWN_CODES.has(code)) {
      return err(code as Parameters<typeof err>[0], cause.message);
    }
    return err('internal', cause.message);
  }
  return err('internal', 'unknown error');
}

const KNOWN_CODES: ReadonlySet<string> = new Set([
  'not_found',
  'bad_args',
  'unauthorized',
  'internal',
  'aborted',
  'subscription_failed',
]);
