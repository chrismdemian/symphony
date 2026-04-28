/**
 * Typed RPC pattern — Phase 2B.2.
 *
 * Direct port of emdash's 53-line shared/ipc/rpc.ts (`research/repos/emdash/
 * src/shared/ipc/rpc.ts:1-53`). The Electron `ipcMain` transport is replaced
 * by Symphony's WebSocket transport (`src/rpc/server.ts`), but the type
 * pattern is byte-for-byte equivalent: identity functions for `T`
 * inference, plus a mapped type that derives the client interface from the
 * server router definition.
 *
 * This file is transport-agnostic. Touch nothing in here when adding
 * procedures — define them in `router-impl.ts`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProcedureMap = Record<string, (...args: any[]) => unknown>;

type RouterMap = Record<string, ProcedureMap>;

/**
 * Identity function whose only job is to give the compiler a `T` to infer.
 * Use it to define a namespace-level set of procedures with full type
 * inference at the call site.
 */
export function createRPCController<T extends ProcedureMap>(handlers: T): T {
  return handlers;
}

/**
 * Identity function for the top-level router shape. Same role as
 * `createRPCController` one level up.
 */
export function createRPCRouter<T extends RouterMap>(routers: T): T {
  return routers;
}

/**
 * Mapped type that derives the client interface from the server router
 * definition. Every procedure becomes `(...args) => Promise<Awaited<Ret>>`
 * — handlers can be sync or async; the wire is always async.
 */
export type IpcClient<R extends RouterMap> = {
  [NS in keyof R]: {
    [P in keyof R[NS]]: R[NS][P] extends (...args: infer A) => infer Ret
      ? (...args: A) => Promise<Awaited<Ret>>
      : never;
  };
};

/**
 * Names that JS runtime invokes on objects for serialization/conversion
 * — e.g. `JSON.stringify` looks up `toJSON`, `String(x)` calls
 * `toString`, etc. Audit M3 (2B.2 review): the original `then`-only
 * guard let phantom RPC calls fire when a TUI accidentally serialized a
 * namespace handle.
 */
const NON_RPC_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  'then',
  'toJSON',
  'toString',
  'valueOf',
  'inspect',
  'constructor',
  'prototype',
]);

function isCallableName(name: string | symbol): name is string {
  if (typeof name !== 'string') return false;
  if (NON_RPC_PROPERTY_NAMES.has(name)) return false;
  return true;
}

/**
 * Build a client proxy whose every property reads as `client[ns][procedure]`
 * and dispatches via the supplied `invoke` function. The `isCallableName`
 * guard prevents phantom RPC calls when JS runtime invokes well-known
 * symbols (`then`, `toJSON`, `toString`, `valueOf`) — accidental
 * `JSON.stringify(client.workers)` would otherwise dispatch a `toJSON`
 * call to the server.
 */
export function createRPCClient<Router extends RouterMap>(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): IpcClient<Router> {
  return new Proxy(
    {},
    {
      get(_target, ns) {
        if (!isCallableName(ns)) return undefined;
        return new Proxy(
          {},
          {
            get(_inner, procedure) {
              if (!isCallableName(procedure)) return undefined;
              return (...args: unknown[]) => invoke(`${ns}.${procedure}`, ...args);
            },
          },
        );
      },
    },
  ) as IpcClient<Router>;
}

/**
 * Look up `router[namespace][procedure]` with strict shape checking.
 * Returns `undefined` when either lookup fails — the dispatcher converts
 * that into a `not_found` envelope.
 */
export function resolveProcedure(
  router: RouterMap,
  namespace: string,
  procedure: string,
): // eslint-disable-next-line @typescript-eslint/no-explicit-any
((...args: any[]) => unknown) | undefined {
  const ns = router[namespace];
  if (!ns) return undefined;
  return ns[procedure];
}
