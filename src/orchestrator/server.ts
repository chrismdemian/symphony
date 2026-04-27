import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { projectRegistryFromMap } from '../projects/registry.js';
import type { ProjectConfigInput, ProjectRecord, ProjectStore } from '../projects/types.js';
import { QuestionRegistry, type QuestionStore } from '../state/question-registry.js';
import { TaskRegistry } from '../state/task-registry.js';
import type { TaskStore } from '../state/types.js';
import type { SymphonyDatabase } from '../state/db.js';
import { SqliteProjectStore } from '../state/sqlite-project-store.js';
import { SqliteTaskStore } from '../state/sqlite-task-store.js';
import { SqliteQuestionStore } from '../state/sqlite-question-store.js';
import { SqliteWaveStore } from '../state/sqlite-wave-store.js';
import { SqliteWorkerStore, type WorkerStore } from '../state/sqlite-worker-store.js';
import { WorkerManager, type WorkerManagerOptions } from '../workers/manager.js';
import { WorktreeManager } from '../worktree/manager.js';
import type { WorktreeManagerConfig } from '../worktree/types.js';
import { CapabilityEvaluator, DEFAULT_DISPATCH_CONTEXT } from './capabilities.js';
import { ModeController } from './mode.js';
import { ToolRegistry } from './registry.js';
import { WaveRegistry, type WaveStore } from './research-wave-registry.js';
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
import { makeAskUserTool } from './tools/ask-user.js';
import { makeReviewDiffTool } from './tools/review-diff.js';
import { makeResearchWaveTool } from './tools/research-wave.js';
import { makeGlobalStatusTool } from './tools/global-status.js';
import { makeAuditChangesTool } from './tools/audit-changes.js';
import { makeFinalizeTool } from './tools/finalize.js';
import { defaultOneShotRunner, type OneShotRunner } from './one-shot.js';
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
  /**
   * Phase 2B.1b — write-through persistence for worker metadata. Defaults
   * to SQLite when `database` is provided. Pass explicitly to override
   * (e.g. an in-memory fake for tests).
   */
  workerStore?: WorkerStore;
  /** Override the lifecycle composition. Test seam — defaults to one composed from registry + managers. */
  workerLifecycle?: WorkerLifecycleHandle;
  /** Override the project store. Defaults to a registry seeded from `projects`. */
  projectStore?: ProjectStore;
  /** Override the task store. Defaults to an in-memory `TaskRegistry`. */
  taskStore?: TaskStore;
  /** Override the question store. Defaults to an in-memory `QuestionRegistry`. */
  questionStore?: QuestionStore;
  /** Override the research-wave store. Defaults to an in-memory `WaveRegistry`. */
  waveStore?: WaveStore;
  /**
   * Per-project configuration overlay (`lintCommand`, `verifyCommand`, etc.).
   * Keyed by project name. Used by `finalize` for the shell-step pipeline.
   * A `.symphony.json` loader (Phase 5) will populate this at CLI startup.
   */
  projectConfigs?: Readonly<Record<string, ProjectConfigInput>>;
  /** Override the one-shot Claude runner used by `audit_changes` + `finalize`. Test seam. */
  oneShotRunner?: OneShotRunner;
  /**
   * Phase 2B.1 — open a SQLite-backed store set. When provided, default
   * impls for `{project,task,question,wave}Store` are SQLite-backed.
   * Explicit store overrides still win. Caller owns `close()`.
   */
  database?: SymphonyDatabase;
}

export interface OrchestratorServerHandle {
  server: McpServer;
  mode: ModeController;
  registry: ToolRegistry;
  safety: AgentSafetyGuard;
  planStore: ProposePlanStore;
  workerRegistry: WorkerRegistry;
  workerStore?: WorkerStore;
  workerLifecycle: WorkerLifecycleHandle;
  workerManager: WorkerManager;
  worktreeManager: WorktreeManager;
  projectStore: ProjectStore;
  taskStore: TaskStore;
  questionStore: QuestionStore;
  waveStore: WaveStore;
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
      if (options.database) {
        const store = new SqliteProjectStore(options.database.db);
        seedProjectsFromMap(store, projects, options.projectConfigs);
        ensureDefaultProjectRegistered(store, defaultProjectPath, options.projectConfigs);
        return store;
      }
      const store = projectRegistryFromMap(projects, {
        ...(options.projectConfigs !== undefined
          ? { configs: options.projectConfigs as Record<string, Partial<ProjectRecord>> }
          : {}),
      });
      ensureDefaultProjectRegistered(store, defaultProjectPath, options.projectConfigs);
      return store;
    })();

  const taskStore: TaskStore =
    options.taskStore ??
    (options.database ? new SqliteTaskStore(options.database.db) : new TaskRegistry());
  const questionStore: QuestionStore =
    options.questionStore ??
    (options.database ? new SqliteQuestionStore(options.database.db) : new QuestionRegistry());
  const waveStore: WaveStore =
    options.waveStore ??
    (options.database ? new SqliteWaveStore(options.database.db) : new WaveRegistry());

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
  const workerStore: WorkerStore | undefined =
    options.workerStore ??
    (options.database ? new SqliteWorkerStore(options.database.db) : undefined);
  const workerRegistry =
    options.workerRegistry ??
    new WorkerRegistry({
      ...(workerStore !== undefined ? { store: workerStore } : {}),
    });
  const workerLifecycle =
    options.workerLifecycle ??
    createWorkerLifecycle({
      registry: workerRegistry,
      workerManager,
      worktreeManager,
      resolveProjectPath: (projectId) => {
        if (projectId === null) return '';
        for (const p of projectStore.list()) {
          if (p.id === projectId) return p.path;
        }
        return '';
      },
    });

  // Phase 2B.1b — startup reconciliation. Persisted workers stuck in
  // `running` or `spawning` at last shutdown could not survive the
  // process boundary; flip them to `crashed` so `list_workers` and
  // `global_status` reflect reality. User/Maestro revives intentional
  // ones via `resume_worker`.
  workerLifecycle.recoverFromStore();

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
      projectStore,
    }),
  );
  registry.register(
    makeListWorkersTool({
      registry: workerRegistry,
      resolveProjectPath: listResolve,
      projectStore,
    }),
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

  registry.register(makeAskUserTool({ questionStore, projectStore }));
  registry.register(makeReviewDiffTool({ registry: workerRegistry }));
  registry.register(
    makeResearchWaveTool({
      registry: workerRegistry,
      lifecycle: workerLifecycle,
      waveStore,
      projectStore,
      resolveProjectPath: spawnResolve,
    }),
  );
  registry.register(
    makeGlobalStatusTool({
      projectStore,
      workerRegistry,
      worktreeManager,
    }),
  );

  const oneShotRunner = options.oneShotRunner ?? defaultOneShotRunner;
  registry.register(
    makeAuditChangesTool({
      registry: workerRegistry,
      projectStore,
      oneShotRunner,
    }),
  );
  registry.register(
    makeFinalizeTool({
      registry: workerRegistry,
      projectStore,
      oneShotRunner,
    }),
  );

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
    ...(workerStore !== undefined ? { workerStore } : {}),
    workerLifecycle,
    workerManager,
    worktreeManager,
    projectStore,
    taskStore,
    questionStore,
    waveStore,
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
 * Seed a SQLite-backed project store from a name→path map. Mirrors
 * `projectRegistryFromMap` for in-memory mode. Skips entries that already
 * exist (idempotent across restarts — the SQL `UNIQUE` constraints would
 * otherwise throw on a second run).
 */
function seedProjectsFromMap(
  store: ProjectStore,
  projects: Readonly<Record<string, string>>,
  configs?: Readonly<Record<string, ProjectConfigInput>>,
): void {
  // Phase 2B.1 audit M3: Skip when the name OR the path already exists.
  // The in-memory registry rejects both — with the audit-M2 fix,
  // path-uniqueness is now symmetrical between in-memory and SQLite.
  // Without this lookup, a re-run of a symphony process with the same
  // `options.projects` map would crash on the second startup.
  for (const [name, pathStr] of Object.entries(projects)) {
    if (!pathStr || typeof pathStr !== 'string') continue;
    if (store.get(name)) continue;
    const resolved = path.resolve(pathStr);
    const existingByPath = store.list().find((r) => path.resolve(r.path) === resolved);
    if (existingByPath) continue;
    const extra = configs?.[name] ?? {};
    store.register({
      id: name,
      name,
      path: pathStr,
      createdAt: '',
      ...extra,
    });
  }
}

/**
 * If the caller gave a `defaultProjectPath` without registering a matching
 * project, synthesize a `default` entry so MCP tools can address it by
 * name. No-op when the store already contains a project at that path.
 * Applies `projectConfigs.default` when the synthesized project is created.
 */
function ensureDefaultProjectRegistered(
  store: ProjectStore,
  defaultPath: string,
  projectConfigs?: Readonly<Record<string, ProjectConfigInput>>,
): void {
  for (const record of store.list()) {
    if (path.resolve(record.path) === defaultPath) return;
  }
  const name = pickDefaultProjectName(store);
  const extra = projectConfigs?.[name] ?? projectConfigs?.['default'];
  store.register({
    id: name,
    name,
    path: defaultPath,
    createdAt: '',
    ...(extra ?? {}),
  });
}

function pickDefaultProjectName(store: ProjectStore): string {
  if (store.get('default') === undefined) return 'default';
  for (let i = 2; i < 1000; i += 1) {
    const name = `default-${i}`;
    if (store.get(name) === undefined) return name;
  }
  throw new Error('ensureDefaultProjectRegistered: exhausted default-N naming');
}
