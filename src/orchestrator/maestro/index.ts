export {
  ensureMaestroWorkspace,
  writeMaestroClaudeMd,
  MAESTRO_CLAUDE_MD_HEADER,
} from './workspace.js';
export type { EnsureMaestroWorkspaceOptions, MaestroWorkspace } from './workspace.js';

export {
  composeMaestroPrompt,
  resolveMaestroPromptsDir,
  MaestroPromptLoadError,
} from './prompt-composer.js';
export type { MaestroPromptVars } from './prompt-composer.js';

export { writeMaestroMcpConfig } from './mcp-config.js';
export type {
  WriteMaestroMcpConfigInput,
  MaestroMcpConfigResult,
  McpServerEntry,
} from './mcp-config.js';

export { resolveMaestroSession, MAESTRO_SESSION_UUID } from './session.js';
export type {
  ResolveMaestroSessionInput,
  ResolvedMaestroSession,
  MaestroSessionFreshReason,
} from './session.js';

export {
  awaitRpcReady,
  connectMaestroRpc,
  RpcReadyTimeoutError,
  RpcReadyAbortedError,
} from './rpc-client-bootstrap.js';
export type {
  AwaitRpcReadyInput,
  RpcReadyDescriptor,
  ConnectMaestroRpcInput,
} from './rpc-client-bootstrap.js';

export { MaestroProcess, MaestroTurnInFlightError } from './process.js';
export type {
  MaestroProcessDeps,
  MaestroStartInput,
  MaestroStartResult,
  MaestroEvent,
} from './process.js';

export { MaestroHookServer } from './hook-server.js';
export type {
  HookPayload,
  HookEventType,
  MaestroHookServerOptions,
  MaestroHookServerStartResult,
} from './hook-server.js';

export {
  installStopHook,
  uninstallStopHook,
  buildStopHookCommand,
} from './hook-installer.js';
export type {
  InstallStopHookInput,
  UninstallStopHookInput,
} from './hook-installer.js';
