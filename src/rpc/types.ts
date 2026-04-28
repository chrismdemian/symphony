/**
 * Shared types re-exported for client consumers (TUI in Phase 3, future
 * Tauri shell, phone client). Importers depend on this barrel rather than
 * pulling from `protocol`/`router` individually.
 */
export type {
  Frame,
  RpcCallFrame,
  RpcResultFrame,
  SubscribeFrame,
  UnsubscribeFrame,
  EventFrame,
  RpcEnvelope,
  RpcError,
  ErrorCode,
} from './protocol.js';

export { ProtocolError, PROTOCOL_VERSION, decodeFrame, encodeFrame, ok, err } from './protocol.js';
export { createRPCController, createRPCRouter, createRPCClient } from './router.js';
export type { IpcClient } from './router.js';
