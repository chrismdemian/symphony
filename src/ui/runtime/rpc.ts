import type { RpcClient } from '../../rpc/client.js';
import type { SymphonyRouter } from '../../rpc/router-impl.js';

/**
 * Minimal RPC surface the TUI consumes.
 *
 * Mirrors the pattern at `src/cli/start.ts:79-86` (`LauncherRpc`):
 * tests inject a fake matching this shape; production passes the real
 * `RpcClient<SymphonyRouter>` (structurally compatible). Avoids dragging
 * the whole router type through every component.
 */
export type TuiRpc = Pick<RpcClient<SymphonyRouter>, 'call' | 'subscribe' | 'close'>;
