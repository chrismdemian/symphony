import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { WorkerManager, type WorkerManagerOptions } from '../workers/manager.js';
import { WorktreeManager } from '../worktree/manager.js';
import type { WorktreeManagerConfig } from '../worktree/types.js';
import { CapabilityEvaluator, DEFAULT_DISPATCH_CONTEXT } from './capabilities.js';
import { ModeController } from './mode.js';
import { ToolRegistry } from './registry.js';
import { AgentSafetyGuard } from './safety.js';
import type { SafetyGuardOptions } from './safety.js';
import { thinkTool } from './tools/think.js';
import { createProposePlanStore, makeProposePlanTool } from './tools/propose-plan.js';
import type { ProposePlanStore } from './tools/propose-plan.js';
import { makeSpawnWorkerTool } from './tools/spawn-worker.js';
import { makeListWorkersTool } from './tools/list-workers.js';
import { makeGetWorkerOutputTool } from './tools/get-worker-output.js';
import { makeSendToWorkerTool } from './tools/send-to-worker.js';
import { makeKillWorkerTool } from './tools/kill-worker.js';
import { makeResumeWorkerTool } from './tools/resume-worker.js';
import { makeFindWorkerTool } from './tools/find-worker.js';
import type { AutonomyTier, DispatchContext, ToolMode } from './types.js';
import { createWorkerLifecycle, type WorkerLifecycleHandle } from './worker-lifecycle.js';
import { WorkerRegistry } from './worker-registry.js';

export interface OrchestratorServerOptions {
  transport?: Transport;
  initialMode?: ToolMode;
  initialTier?: AutonomyTier;
  safety?: SafetyGuardOptions;
  name?: string;
  version?: string;
  /** Absolute path to the default project. Workers spawn into `<project>/.symphony/worktrees/<id>`. */
  defaultProjectPath?: string;
  /** Optional name→path registry for multi-project resolution (Phase 5 groundwork). */
  projects?: Readonly<Record<string, string>>;
  workerManager?: WorkerManager;
  workerManagerOptions?: WorkerManagerOptions;
  worktreeManager?: WorktreeManager;
  worktreeManagerConfig?: WorktreeManagerConfig;
  /** Override the in-memory WorkerRegistry. Test seam. */
  workerRegistry?: WorkerRegistry;
  /** Override the lifecycle composition. Test seam — defaults to one composed from registry + managers. */
  workerLifecycle?: WorkerLifecycleHandle;
}

export interface OrchestratorServerHandle {
  server: McpServer;
  mode: ModeController;
  registry: ToolRegistry;
  safety: AgentSafetyGuard;
  planStore: ProposePlanStore;
  workerRegistry: WorkerRegistry;
  workerLifecycle: WorkerLifecycleHandle;
  workerManager: WorkerManager;
  worktreeManager: WorktreeManager;
  defaultProjectPath: string;
  resolveProjectPath: (project?: string) => string;
  setContext: (partial: Partial<DispatchContext>) => void;
  getContext: () => DispatchContext;
  close: () => Promise<void>;
}

export async function startOrchestratorServer(
  options: OrchestratorServerOptions = {},
): Promise<OrchestratorServerHandle> {
  const server = new McpServer(
    { name: options.name ?? 'symphony', version: options.version ?? '0.0.0' },
    {
      capabilities: { tools: { listChanged: true }, logging: {} },
      instructions:
        'Symphony orchestrator MCP server. Tool availability is mode-gated: PLAN mode exposes planning tools, ACT mode exposes worker lifecycle tools. Delegator tools never edit source files directly.',
    },
  );

  const mode = new ModeController({ initial: options.initialMode ?? 'plan' });
  const safety = new AgentSafetyGuard(options.safety);
  const capabilityEvaluator = new CapabilityEvaluator();

  let context: DispatchContext = {
    ...DEFAULT_DISPATCH_CONTEXT,
    mode: mode.mode,
    tier: options.initialTier ?? DEFAULT_DISPATCH_CONTEXT.tier,
  };
  const offModeChange = mode.onChange((evt) => {
    context = { ...context, mode: evt.next };
  });

  const registry = new ToolRegistry({
    server,
    mode,
    safety,
    capabilityEvaluator,
    getContext: () => context,
  });

  const defaultProjectPath = path.resolve(options.defaultProjectPath ?? process.cwd());
  const projects = options.projects ?? {};

  const resolveProjectPath = (project?: string): string => {
    if (project === undefined || project.length === 0) return defaultProjectPath;
    if (Object.prototype.hasOwnProperty.call(projects, project)) {
      return path.resolve(projects[project] as string);
    }
    // Accept absolute path fallback for Phase 5 pre-registry mode.
    if (path.isAbsolute(project)) return path.resolve(project);
    throw new Error(
      `Unknown project '${project}'. Register it via OrchestratorServerOptions.projects or pass an absolute path.`,
    );
  };

  const workerManager =
    options.workerManager ?? new WorkerManager(options.workerManagerOptions ?? {});
  const worktreeManager =
    options.worktreeManager ?? new WorktreeManager(options.worktreeManagerConfig ?? {});
  const workerRegistry = options.workerRegistry ?? new WorkerRegistry();
  const workerLifecycle =
    options.workerLifecycle ??
    createWorkerLifecycle({
      registry: workerRegistry,
      workerManager,
      worktreeManager,
    });

  const planStore = createProposePlanStore();
  registry.register(thinkTool);
  registry.register(makeProposePlanTool(planStore));

  const spawnResolve = (project?: string): string => resolveProjectPath(project);
  const listResolve = (project?: string): string | undefined =>
    project !== undefined ? resolveProjectPath(project) : undefined;
  registry.register(
    makeSpawnWorkerTool({
      registry: workerRegistry,
      lifecycle: workerLifecycle,
      resolveProjectPath: spawnResolve,
    }),
  );
  registry.register(
    makeListWorkersTool({ registry: workerRegistry, resolveProjectPath: listResolve }),
  );
  registry.register(makeGetWorkerOutputTool({ registry: workerRegistry }));
  registry.register(makeSendToWorkerTool({ registry: workerRegistry }));
  registry.register(makeKillWorkerTool({ registry: workerRegistry }));
  registry.register(
    makeResumeWorkerTool({ registry: workerRegistry, lifecycle: workerLifecycle }),
  );
  registry.register(makeFindWorkerTool({ registry: workerRegistry }));

  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);

  const close = async (): Promise<void> => {
    offModeChange();
    registry.close();
    await workerLifecycle.shutdown().catch(() => {});
    try {
      await server.close();
    } catch {
      // already closed
    }
  };

  return {
    server,
    mode,
    registry,
    safety,
    planStore,
    workerRegistry,
    workerLifecycle,
    workerManager,
    worktreeManager,
    defaultProjectPath,
    resolveProjectPath,
    setContext: (partial) => {
      context = { ...context, ...partial, mode: mode.mode };
    },
    getContext: () => context,
    close,
  };
}
