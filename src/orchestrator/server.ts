import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { projectRegistryFromMap } from '../projects/registry.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { ProjectStore } from '../projects/types.js';
import { TaskRegistry } from '../state/task-registry.js';
import type { TaskStore } from '../state/types.js';
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
import { makeListProjectsTool } from './tools/list-projects.js';
import { makeGetProjectInfoTool } from './tools/get-project-info.js';
import { makeCreateWorktreeTool } from './tools/create-worktree.js';
import { makeListTasksTool } from './tools/list-tasks.js';
import { makeCreateTaskTool } from './tools/create-task.js';
import { makeUpdateTaskTool } from './tools/update-task.js';
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
  /** Override the project store. Defaults to a registry seeded from `projects`. */
  projectStore?: ProjectStore;
  /** Override the task store. Defaults to an in-memory `TaskRegistry`. */
  taskStore?: TaskStore;
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
  projectStore: ProjectStore;
  taskStore: TaskStore;
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

  const projectStore: ProjectStore =
    options.projectStore ??
    (() => {
      const store = projectRegistryFromMap(projects);
      ensureDefaultProjectRegistered(store, defaultProjectPath);
      return store;
    })();

  const taskStore: TaskStore = options.taskStore ?? new TaskRegistry();

  const resolveProjectPath = (project?: string): string => {
    if (project === undefined || project.length === 0) return defaultProjectPath;
    const stored = projectStore.get(project);
    if (stored) return stored.path;
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

  registry.register(makeListProjectsTool({ store: projectStore }));
  registry.register(
    makeGetProjectInfoTool({ store: projectStore, workerRegistry }),
  );
  registry.register(
    makeCreateWorktreeTool({ store: projectStore, worktreeManager }),
  );
  registry.register(
    makeListTasksTool({ taskStore, projectStore }),
  );
  registry.register(
    makeCreateTaskTool({ taskStore, projectStore }),
  );
  registry.register(makeUpdateTaskTool({ taskStore }));

  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);

  const close = async (): Promise<void> => {
    offModeChange();
    registry.close();
    // Order: lifecycle drains registered workers; workerManager shutdown
    // rejects new spawns AND awaits any child still mid-boot between
    // `workerManager.spawn` resolving and `registry.register` running.
    // Without this pair, SIGINT during a `spawn_worker` call leaks the
    // pending claude subprocess.
    await workerLifecycle.shutdown().catch(() => {});
    await workerManager.shutdown().catch(() => {});
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
    projectStore,
    taskStore,
    defaultProjectPath,
    resolveProjectPath,
    setContext: (partial) => {
      context = { ...context, ...partial, mode: mode.mode };
    },
    getContext: () => context,
    close,
  };
}

/**
 * If the caller gave a `defaultProjectPath` without registering a matching
 * project, synthesize a `default` entry so MCP tools can address it by
 * name. No-op when the store already contains a project at that path.
 */
function ensureDefaultProjectRegistered(
  store: ProjectRegistry,
  defaultPath: string,
): void {
  for (const record of store.list()) {
    if (path.resolve(record.path) === defaultPath) return;
  }
  const name = pickDefaultProjectName(store);
  store.register({
    id: name,
    name,
    path: defaultPath,
    createdAt: '',
  });
}

function pickDefaultProjectName(store: ProjectRegistry): string {
  if (store.get('default') === undefined) return 'default';
  for (let i = 2; i < 1000; i += 1) {
    const name = `default-${i}`;
    if (store.get(name) === undefined) return name;
  }
  throw new Error('ensureDefaultProjectRegistered: exhausted default-N naming');
}
