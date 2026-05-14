import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { projectRegistryFromMap } from '../projects/registry.js';
import type { ProjectConfigInput, ProjectRecord, ProjectStore } from '../projects/types.js';
import { QuestionRegistry, type QuestionStore } from '../state/question-registry.js';
import { TaskRegistry } from '../state/task-registry.js';
import type { TaskSnapshot, TaskStore } from '../state/types.js';
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
import type { AutonomyTier, CapabilityNotice, DispatchContext, ToolMode } from './types.js';
import { createWorkerLifecycle, type WorkerLifecycleHandle } from './worker-lifecycle.js';
import { WorkerRegistry } from './worker-registry.js';
import { WorkerEventBroker } from '../rpc/event-broker.js';
import {
  generateRpcToken,
  writeRpcDescriptor,
  deleteRpcDescriptor,
  defaultRpcTokenFilePath,
} from '../rpc/auth.js';
import { startRpcServer, type RpcServerHandle } from '../rpc/server.js';
import { createSymphonyRouter } from '../rpc/router-impl.js';
import { loadConfig } from '../utils/config.js';
import { readSymphonyConfig } from '../worktree/symphony-config.js';
import { createNotificationDispatcher } from '../notifications/dispatcher.js';
import type { DispatcherHandle } from '../notifications/types.js';
import { spawnToast } from '../notifications/spawn-toast.js';
import { createCompletionSummarizer } from './completion-summarizer.js';
import { WorkerCompletionsBroker } from './completions-broker.js';
import type {
  CompletionsBroker,
  CompletionSummarizerHandle,
  OneShotInvoker,
} from './completion-summarizer-types.js';
import { createAutoMergeBroker } from './auto-merge-broker.js';
import { createAutoMergeDispatcher } from './auto-merge-dispatcher.js';
import { createTaskReadyBroker } from './task-ready-broker.js';
import { createTaskReadyDispatcher } from './task-ready-dispatcher.js';
import * as gitOps from './git-ops.js';
import type {
  AutoMergeBroker,
  AutoMergeDispatcherHandle,
} from './auto-merge-types.js';
import type {
  TaskReadyBroker,
  TaskReadyDispatcherHandle,
} from './task-ready-types.js';

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
  /**
   * Phase 2B.2 — start a parallel WebSocket RPC server alongside the MCP
   * transport. Default OFF for library callers (zero side effects: no
   * port, no token file). The `symphony mcp-server` CLI command opts in
   * explicitly via `{ enabled: true }`. Tests that exercise the RPC
   * surface pass `{ enabled: true, port: 0, skipDescriptorFile: true }`.
   */
  rpc?: RpcOptions;
  /**
   * Phase 3H.3 — override the notifications dispatcher. Test seam: pass
   * a stub with the same shape as `DispatcherHandle` to assert toast
   * spawns without touching the real platform tools. Defaults to a real
   * dispatcher with `loadConfig` + `spawnToast` from `src/notifications`.
   */
  notificationDispatcher?: DispatcherHandle;
  /**
   * Phase 3K — override the completion-summarizer broker. Test seam:
   * pass a `WorkerCompletionsBroker` stub or spy to inspect what the
   * summarizer publishes. Defaults to a fresh `WorkerCompletionsBroker`.
   */
  completionsBroker?: CompletionsBroker;
  /**
   * Phase 3K — override the completion summarizer. Test seam: pass a
   * stub `CompletionSummarizerHandle` to bypass the one-shot Claude
   * call entirely. Defaults to a real summarizer wrapping the same
   * `oneShotRunner` used by `audit_changes` + `finalize`.
   */
  completionSummarizer?: CompletionSummarizerHandle;
  /**
   * Phase 3O.1 — override the auto-merge broker. Test seam.
   */
  autoMergeBroker?: AutoMergeBroker;
  /**
   * Phase 3O.1 — override the auto-merge dispatcher. Test seam.
   */
  autoMergeDispatcher?: AutoMergeDispatcherHandle;
  /**
   * Phase 3P — override the task-ready broker. Test seam.
   */
  taskReadyBroker?: TaskReadyBroker;
  /**
   * Phase 3P — override the task-ready dispatcher. Test seam.
   */
  taskReadyDispatcher?: TaskReadyDispatcherHandle;
}

export interface RpcOptions {
  readonly enabled?: boolean;
  readonly host?: string;
  readonly port?: number;
  /** Override the generated token. Default: random 32 bytes hex per process. */
  readonly token?: string;
  /** Override the token-descriptor file path. Default: `~/.symphony/rpc.json`. */
  readonly tokenFilePath?: string;
  /** Skip writing the descriptor file (useful in tests). */
  readonly skipDescriptorFile?: boolean;
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
  /** Phase 3H.3 — exposed for tests + the RPC layer's `flushAwayDigest`. */
  notificationDispatcher: DispatcherHandle;
  /** Phase 3K — exposed for tests that need to subscribe directly. */
  completionsBroker: CompletionsBroker;
  /** Phase 3K — exposed for tests that need to wait on shutdown drain. */
  completionSummarizer: CompletionSummarizerHandle;
  /** Phase 3O.1 — exposed for tests that subscribe to auto-merge events. */
  autoMergeBroker: AutoMergeBroker;
  /** Phase 3O.1 — exposed for tests that need to wait on shutdown drain. */
  autoMergeDispatcher: AutoMergeDispatcherHandle;
  /** Phase 3P — exposed for tests that subscribe to task-ready events. */
  taskReadyBroker: TaskReadyBroker;
  /** Phase 3P — exposed for tests that need to wait on shutdown drain. */
  taskReadyDispatcher: TaskReadyDispatcherHandle;
  defaultProjectPath: string;
  resolveProjectPath: (project?: string) => string;
  setContext: (partial: Partial<DispatchContext>) => void;
  getContext: () => DispatchContext;
  /** Phase 2B.2 — present when `options.rpc.enabled !== false`. */
  rpc?: RpcServerHandle & { token: string; tokenFilePath?: string };
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

  // Phase 3S — capability first-use notice sink. Today the only
  // consumer is the capability evaluator's `requires-secrets-read`
  // first-use branch at Tier 2, but no tool with that flag ships in
  // Symphony's 3S codebase (the first real consumer is the Chrome
  // DevTools MCP plugin in Phase 7). The seam is wired through the
  // registry NOW so when Phase 7 adds its first secrets-read tool, the
  // wiring is already in place — we just swap this stderr stub for a
  // TUI toast broker. Stderr is intercepted by the launcher and tagged
  // with `[symphony:capability]` so the user sees something even before
  // a toast surface exists.
  const noticeSink = (notice: CapabilityNotice): void => {
    if (typeof process !== 'undefined' && process.stderr?.writable) {
      process.stderr.write(
        `[symphony:capability] first-use of ${notice.flag} via tool '${notice.tool}'\n`,
      );
    }
  };
  const registry = new ToolRegistry({
    server,
    mode,
    safety,
    capabilityEvaluator,
    getContext: () => context,
    noticeSink,
  });

  const defaultProjectPath = path.resolve(options.defaultProjectPath ?? process.cwd());
  const projects = options.projects ?? {};

  const projectStore: ProjectStore =
    options.projectStore ??
    (() => {
      if (options.database) {
        const store = new SqliteProjectStore(options.database.db);
        seedProjectsFromMap(store, projects, options.projectConfigs);
        return store;
      }
      const store = projectRegistryFromMap(projects, {
        ...(options.projectConfigs !== undefined
          ? { configs: options.projectConfigs as Record<string, Partial<ProjectRecord>> }
          : {}),
      });
      return store;
    })();

  // Phase 3P — holder pattern for the task-ready dispatcher, mirroring
  // 3O.1's autoMergeDispatcherRef. The taskStore needs an
  // `onTaskStatusChange` callback AT CONSTRUCTION, but the dispatcher
  // needs the taskStore as a dep. We construct the holder, point the
  // store's callback at it, then fill it immediately after the
  // dispatcher is created. By the time any status change actually
  // fires (via a tool dispatch), the ref is live.
  const taskReadyDispatcherRef: { current?: TaskReadyDispatcherHandle } = {};
  const taskReadyOnTaskStatusChange = (snapshot: TaskSnapshot): void => {
    taskReadyDispatcherRef.current?.onTaskStatusChange(snapshot);
  };
  const taskStore: TaskStore =
    options.taskStore ??
    (options.database
      ? new SqliteTaskStore(options.database.db, {
          onTaskStatusChange: taskReadyOnTaskStatusChange,
        })
      : new TaskRegistry({
          projectStore,
          onTaskStatusChange: taskReadyOnTaskStatusChange,
        }));
  // Phase 3H.3 — instantiate the notifications dispatcher BEFORE the
  // question store so its `onQuestionEnqueued` hook is wired at the
  // store's construction. The dispatcher reads `loadConfig` fresh per
  // dispatch (suppression matrix lives there); the per-platform spawn
  // shim is the test-injectable seam (real `spawnToast` by default).
  const fallbackProjectLabel = path.basename(defaultProjectPath) || 'project';
  const notificationDispatcher: DispatcherHandle =
    options.notificationDispatcher ??
    createNotificationDispatcher({
      loadConfig,
      spawnToast: (input) => spawnToast(input),
      getProjectName: (projectId) => {
        if (projectId === null || projectId === '') return fallbackProjectLabel;
        const stored = projectStore.get(projectId);
        return stored?.name ?? fallbackProjectLabel;
      },
    });

  // Phase 3K — completion summarizer broker + dispatcher. Both default
  // to fresh instances; tests can inject their own. The summarizer
  // wraps the same `oneShotRunner` used by `audit_changes` + `finalize`
  // so a single `--claude-binary` swap covers all three call sites.
  // `getProjectName` mirrors the notifications dispatcher for parity;
  // `getWorkerName` returns a server-side fallback (the TUI overrides
  // via its instrument allocator at receipt time — see
  // `useCompletionEvents`). Server-side has no instrument concept.
  const completionsBroker: CompletionsBroker =
    options.completionsBroker ?? new WorkerCompletionsBroker();
  const projectNameForRecord = (record: { projectId: string | null }): string => {
    if (record.projectId === null || record.projectId === '') return fallbackProjectLabel;
    const stored = projectStore.get(record.projectId);
    return stored?.name ?? fallbackProjectLabel;
  };
  const summarizerOneShot: OneShotInvoker = async (input) => {
    const runner = options.oneShotRunner ?? defaultOneShotRunner;
    const result = await runner({
      prompt: input.prompt,
      cwd: input.cwd,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    return { text: result.text, exitCode: result.exitCode };
  };
  const completionSummarizer: CompletionSummarizerHandle =
    options.completionSummarizer ??
    createCompletionSummarizer({
      broker: completionsBroker,
      oneShot: summarizerOneShot,
      getWorkerName: (record) => `worker-${record.id.slice(0, 6)}`,
      getProjectName: (record) => projectNameForRecord(record),
    });

  // Phase 3O.1 — holder pattern resolves the chicken-and-egg between
  // questionStore (needs `onQuestionAnswered: (r) => dispatcher.onQuestionAnswered(r)`
  // at construction) and autoMergeDispatcher (needs questionStore as a
  // dep). The holder is filled in immediately after the dispatcher is
  // created; by the time any answer fires, the reference is live.
  const autoMergeDispatcherRef: { current?: AutoMergeDispatcherHandle } = {};
  const questionStore: QuestionStore =
    options.questionStore ??
    (options.database
      ? new SqliteQuestionStore(options.database.db, {
          onQuestionEnqueued: (record) => notificationDispatcher.onQuestion(record),
          onQuestionAnswered: (record) =>
            autoMergeDispatcherRef.current?.onQuestionAnswered(record),
        })
      : new QuestionRegistry({
          onQuestionEnqueued: (record) => notificationDispatcher.onQuestion(record),
          onQuestionAnswered: (record) =>
            autoMergeDispatcherRef.current?.onQuestionAnswered(record),
        }));
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

  // Phase 3O.1 — auto-merge broker + dispatcher. Construct AFTER
  // worktreeManager (the dispatcher needs `.remove`) and AFTER
  // questionStore (the dispatcher needs `.enqueue`). Fills in the
  // `autoMergeDispatcherRef` holder so the questionStore's
  // `onQuestionAnswered` closure resolves to a live dispatcher by the
  // time any answer fires. Test overrides via
  // `options.autoMergeBroker` / `options.autoMergeDispatcher`.
  const autoMergeBroker: AutoMergeBroker =
    options.autoMergeBroker ?? createAutoMergeBroker();
  const autoMergeDispatcher: AutoMergeDispatcherHandle =
    options.autoMergeDispatcher ??
    createAutoMergeDispatcher({
      loadConfig,
      questionStore,
      broker: autoMergeBroker,
      gitOps,
      worktreeManager,
      getProjectName: (projectPath) => {
        // Resolve via projectStore.list() to find a registered project
        // by absolute path; fall back to the basename. Mirrors the
        // shape of the notification dispatcher's resolver but keyed by
        // path rather than id.
        const resolved = path.resolve(projectPath);
        for (const p of projectStore.list()) {
          if (path.resolve(p.path) === resolved) return p.name;
        }
        return path.basename(resolved) || 'project';
      },
    });
  autoMergeDispatcherRef.current = autoMergeDispatcher;

  // Phase 3P — task-ready broker + dispatcher. Construct AFTER
  // `taskStore` (the dispatcher needs `.list` + `.snapshot`) and AFTER
  // `projectStore` (the resolver consults it). Fills
  // `taskReadyDispatcherRef` so the store's `onTaskStatusChange`
  // closure resolves to a live dispatcher by the time any update
  // actually fires. Test overrides via
  // `options.taskReadyBroker` / `options.taskReadyDispatcher`.
  const taskReadyBroker: TaskReadyBroker =
    options.taskReadyBroker ?? createTaskReadyBroker();
  const taskReadyDispatcher: TaskReadyDispatcherHandle =
    options.taskReadyDispatcher ??
    createTaskReadyDispatcher({
      taskStore,
      broker: taskReadyBroker,
      getProjectName: (projectId) => {
        if (projectId.length === 0) return fallbackProjectLabel;
        const stored = projectStore.get(projectId);
        return stored?.name ?? fallbackProjectLabel;
      },
    });
  taskReadyDispatcherRef.current = taskReadyDispatcher;

  // Phase 2B.1 m6: prune `default-N` orphan rows that have no live
  // task / worker references BEFORE we synthesize a new default. Stale
  // rows accumulate when the cwd shifts across restarts (e.g. running
  // `symphony mcp-server` from different folders against the same DB).
  pruneOrphanDefaultProjects(projectStore, taskStore, workerStore, defaultProjectPath);
  ensureDefaultProjectRegistered(projectStore, defaultProjectPath, options.projectConfigs);

  const workerRegistry =
    options.workerRegistry ??
    new WorkerRegistry({
      ...(workerStore !== undefined ? { store: workerStore } : {}),
    });
  // Phase 2B.2 — single broker per orchestrator. The lifecycle's tap fans
  // events into the broker; RPC clients subscribe through the dispatcher.
  const eventBroker = new WorkerEventBroker();
  // Phase 3H.2 — concurrency cap. Resolve global default ONCE at server
  // startup; cap changes mid-session require restart (same shape as
  // `modelMode`'s mid-session contract). Per-project `.symphony.json`
  // is read fresh on each gate check via `readSymphonyConfig`, so a
  // project can adjust its own cap without orchestrator restart.
  //
  // Out-of-range values fall back to the global default. Schema bounds
  // (`maxConcurrentWorkers: 1..32`) are enforced at the global config
  // layer; per-project values clamp at the gate to avoid crashing
  // worktree creation when a user typo'd their `.symphony.json`.
  //
  // Audit m7: defensive try/catch on loadConfig. Documented contract
  // is "never throws", but a future regression in that contract
  // shouldn't tank orchestrator boot for a config-read concern.
  let globalMaxWorkers: number;
  let globalModelMode: 'opus' | 'mixed';
  let bootAwayMode: boolean;
  let bootAutonomyTier: AutonomyTier;
  try {
    const bootGlobalConfig = await loadConfig();
    globalMaxWorkers = bootGlobalConfig.config.maxConcurrentWorkers;
    globalModelMode = bootGlobalConfig.config.modelMode;
    bootAwayMode = bootGlobalConfig.config.awayMode;
    bootAutonomyTier = bootGlobalConfig.config.autonomyTier;
  } catch {
    const fallback = (await import('../utils/config-schema.js')).defaultConfig();
    globalMaxWorkers = fallback.maxConcurrentWorkers;
    globalModelMode = fallback.modelMode;
    bootAwayMode = fallback.awayMode;
    bootAutonomyTier = fallback.autonomyTier;
  }
  // Phase 3M / 3S — stamp the dispatch context with the persisted runtime
  // flags so the capability shim's guards take effect on the first tool
  // call after boot, even before the TUI mounts and pushes
  // `runtime.setAwayMode` / `runtime.setAutonomyTier` over RPC. Without
  // these, a user who quit while away (or at a non-default tier) would
  // silently lose the protection on the next session until they
  // re-toggled. `options.initialTier` wins over the disk read when
  // explicitly provided (test rigs); otherwise disk wins.
  context = {
    ...context,
    awayMode: bootAwayMode,
    tier: options.initialTier ?? bootAutonomyTier,
  };
  // Phase 3H.2 — model mode → default-model resolver. opus → every
  // spawn that doesn't pass an explicit `model:` runs on Opus 4.7.
  // mixed → no default; Maestro's explicit per-task `model` arg wins
  // (matching the v1 prompt's "Always pass model: explicitly" rule).
  const getDefaultModel = (): string | undefined => {
    return globalModelMode === 'opus' ? 'claude-opus-4-7' : undefined;
  };
  const getMaxConcurrentWorkers = (projectPath: string): number => {
    // Audit C2: short-circuit on empty path. Otherwise
    // `readSymphonyConfig('')` calls `path.join('', '.symphony.json')`
    // → '.symphony.json' (relative) → `fs.readFileSync` reads from
    // process.cwd(), which is whatever directory the orchestrator was
    // launched from (commonly Maestro's workspace, NOT the user's
    // project). Empty paths come from the rehydration fallback when a
    // worker's `projectId` doesn't resolve back to a registered project.
    if (projectPath.length === 0) return globalMaxWorkers;
    const projectCfg = readSymphonyConfig(projectPath);
    const v = projectCfg?.maxConcurrentWorkers;
    if (v !== undefined && Number.isInteger(v) && v >= 1 && v <= 32) {
      return v;
    }
    return globalMaxWorkers;
  };
  // Phase 3S — default autonomy tier for spawn-time fallback. Reads
  // from the live dispatch context cursor so a user's Ctrl+Y mid-session
  // immediately affects subsequent spawns. The context.tier value is
  // kept in sync with `config.autonomyTier` via `setDispatchAutonomyTier`
  // (called by the runtime.setAutonomyTier RPC).
  const getDefaultAutonomyTier = (): AutonomyTier => context.tier;
  const workerLifecycle =
    options.workerLifecycle ??
    createWorkerLifecycle({
      registry: workerRegistry,
      workerManager,
      worktreeManager,
      getMaxConcurrentWorkers,
      getDefaultModel,
      getDefaultAutonomyTier,
      resolveProjectPath: (projectId) => {
        if (projectId === null) return '';
        for (const p of projectStore.list()) {
          if (p.id === projectId) return p.path;
        }
        return '';
      },
      // Phase 3H.3 — dispatcher receives the post-decrement total
      // running count. The lifecycle fires this AFTER markCompleted +
      // release(), so totalRunning === 0 truly means "no workers
      // anywhere" by the time the all-done check runs.
      // Phase 3K — completion summarizer rides the same hook in
      // parallel. Order: notifications first (toast latency-sensitive),
      // summarizer second (one-shot is fire-and-forget). Both calls are
      // sync from the lifecycle's perspective; their internal awaits
      // don't block the lifecycle wireExit chain.
      onWorkerStatusChange: (record, totalRunning) => {
        notificationDispatcher.onWorkerExit(record, totalRunning);
        completionSummarizer.onWorkerExit(record);
      },
    });
  // Late-bind the broker callback so it works whether the lifecycle was
  // default-constructed above OR injected via `options.workerLifecycle`
  // (Audit m12 — silent broker bypass via the test seam).
  workerLifecycle.setOnEvent((workerId, event) => eventBroker.publish(workerId, event));

  // Phase 2B.1b — startup reconciliation. Persisted workers stuck in
  // `running` or `spawning` at last shutdown could not survive the
  // process boundary; flip them to `crashed` so `list_workers` and
  // `global_status` reflect reality. User/Maestro revives intentional
  // ones via `resume_worker`.
  //
  // Phase 3Q — capture the report so the `recovery.report` RPC can
  // surface it to the launcher (which threads to the TUI as a chat
  // banner). Snapshot is frozen here; repeat RPC calls return the same
  // value for the life of the server.
  const recoveryReport = {
    crashedIds: workerLifecycle.recoverFromStore().crashedIds,
    capturedAt: new Date().toISOString(),
  };

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
      // Phase 3P — enables the optional task_id auto-link path:
      // spawn_worker validates task readiness, atomically flips
      // pending → in_progress, and stamps task.workerId post-spawn.
      taskStore,
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
      // Phase 3O.1 — hand the dispatcher into finalize. Fires AFTER
      // `finalizeRunner` returns successfully (and only when Maestro did
      // NOT pass `merge_to`). The dispatcher's onFinalize is detached
      // from the caller's promise — finalize's structured return is
      // unaffected by dispatcher-side throws.
      onFinalize: (result, ctx) => autoMergeDispatcher.onFinalize(result, ctx),
    }),
  );

  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);

  const rpcConfig = options.rpc ?? {};
  // Default OFF — library callers must opt in. The `symphony mcp-server`
  // CLI command sets `{ enabled: true }` explicitly.
  const rpcEnabled = rpcConfig.enabled === true;
  let rpcHandle: (RpcServerHandle & { token: string; tokenFilePath?: string }) | undefined;
  if (rpcEnabled) {
    const token = rpcConfig.token ?? generateRpcToken();
    const router = createSymphonyRouter({
      projectStore,
      taskStore,
      questionStore,
      waveStore,
      workerRegistry,
      modeController: mode,
      notificationDispatcher,
      workerLifecycle,
      // Phase 3M — bridge from the TUI's `awayMode` config flips into
      // the live dispatch context. The capability shim reads
      // `ctx.awayMode` per tool call; without this seam the field would
      // stay at the boot-time value for the life of the process.
      setDispatchAwayMode: (value) => {
        context = { ...context, awayMode: value };
      },
      // Phase 3S — same shape as setDispatchAwayMode but for the tier
      // cursor. The closure ALSO clears the capability evaluator's
      // first-use seen-set so notices re-arm: changing the tier is an
      // implicit re-confirmation of intent, and a stale tier-2 session
      // shouldn't silently suppress notices after the user dialed up to
      // tier-3-then-back. Symphony 6-site rule reference impl.
      setDispatchAutonomyTier: (value) => {
        context = { ...context, tier: value };
        capabilityEvaluator.resetFirstUseTracker();
      },
      // Phase 3N.2 — stamp orchestrator boot so the stats aggregator
      // can filter crash-recovered workers (their createdAt predates
      // this) out of the "this session" tally. Stamped once per
      // `startOrchestratorServer` invocation, never mutated thereafter.
      orchestratorBootIso: new Date().toISOString(),
      // Phase 3Q — boot-time recovery snapshot for the launcher's TUI
      // banner. Captured above before this server was even constructed,
      // so RPC clients see a stable value from the first call.
      recoveryReport,
    });
    const handle = await startRpcServer({
      router: router as unknown as Parameters<typeof startRpcServer>[0]['router'],
      broker: eventBroker,
      token,
      // Phase 2B.2 m6 — only known workers can subscribe to `workers.events`.
      // Recovery rehydrates persisted workers BEFORE this server is created
      // (lifecycle.recoverFromStore is called above), so recovered crashed
      // workers ARE in the registry here. New workers spawned via MCP after
      // this point register synchronously before any event fans out.
      workerExists: (workerId: string) => workerRegistry.get(workerId) !== undefined,
      // Phase 3K — accept `subscribe('completions.events')` from the TUI.
      completionsBroker,
      // Phase 3O.1 — accept `subscribe('auto-merge.events')` from the TUI.
      autoMergeBroker,
      // Phase 3P — accept `subscribe('task-ready.events')` from the TUI.
      taskReadyBroker,
      ...(rpcConfig.host !== undefined ? { host: rpcConfig.host } : {}),
      ...(rpcConfig.port !== undefined ? { port: rpcConfig.port } : {}),
    });
    let tokenFilePath: string | undefined;
    if (!rpcConfig.skipDescriptorFile) {
      tokenFilePath = rpcConfig.tokenFilePath ?? defaultRpcTokenFilePath();
      await writeRpcDescriptor(
        {
          host: handle.host,
          port: handle.port,
          token,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        tokenFilePath,
      );
    }
    rpcHandle = {
      ...handle,
      token,
      ...(tokenFilePath !== undefined ? { tokenFilePath } : {}),
    };
  }

  const close = async (): Promise<void> => {
    offModeChange();
    registry.close();
    // Order: stop accepting RPC clients first so no new reads outlive
    // stores; then flush the notifications dispatcher so any awayMode
    // backlog gets one final digest BEFORE the lifecycle tears down
    // its hooks; then drain lifecycle/workerManager; finally close the
    // MCP transport. RPC's broker drops listeners on close, so any
    // in-flight event publishes from late-exiting workers go to
    // /dev/null cleanly.
    if (rpcHandle !== undefined) {
      await rpcHandle.close().catch(() => {});
      eventBroker.clear();
      completionsBroker.clear();
      autoMergeBroker.clear();
      taskReadyBroker.clear();
      if (rpcHandle.tokenFilePath !== undefined) {
        await deleteRpcDescriptor(rpcHandle.tokenFilePath).catch(() => {});
      }
    }
    // Phase 3O.1 — drain auto-merge in-flights FIRST (before the
    // summarizer). Both finalize-tap dispatchers chain off the same
    // lifecycle window; auto-merge can spawn a (slow) git merge process,
    // so draining it before the SIGTERM kill window prevents orphan
    // git children. The summarizer is faster (single one-shot Claude
    // call) so it can drain second.
    await autoMergeDispatcher.shutdown().catch(() => {});
    // Phase 3P — drain task-ready BEFORE the lifecycle's SIGTERM kill
    // window. A worker exit during graceful drain can update a task's
    // status to completed via Maestro's late update_task; that would
    // otherwise fan out a chat row to a dying TUI. shutdown() is sync
    // today but the contract is async to match AutoMergeDispatcher.
    await taskReadyDispatcher.shutdown().catch(() => {});
    // Phase 3K — drain summarizer in-flights BEFORE the lifecycle's
    // SIGTERM kill window. Workers that fail-class-exit during the kill
    // would otherwise re-enter `onWorkerExit` post-disposed and (with
    // the disposed-flag guard) silently no-op. Drain first to publish
    // legitimate summaries, then disposed-flag covers the rest.
    await completionSummarizer.shutdown().catch(() => {});
    await notificationDispatcher.shutdown().catch(() => {});
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
    notificationDispatcher,
    completionsBroker,
    completionSummarizer,
    autoMergeBroker,
    autoMergeDispatcher,
    taskReadyBroker,
    taskReadyDispatcher,
    defaultProjectPath,
    resolveProjectPath,
    setContext: (partial) => {
      context = { ...context, ...partial, mode: mode.mode };
    },
    getContext: () => context,
    ...(rpcHandle !== undefined ? { rpc: rpcHandle } : {}),
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
    const existingByName = store.get(name);
    const resolved = path.resolve(pathStr);
    if (existingByName) {
      // Phase 2B.1 m9: surface drift between caller's map and DB-stored
      // path so the user knows the seed didn't apply. Non-fatal — the DB
      // wins (existing tasks/workers reference the stored id).
      if (path.resolve(existingByName.path) !== resolved) {
        console.warn(
          `[symphony] seed-map drift: project '${name}' is registered at ` +
            `'${existingByName.path}' but options.projects pointed to '${pathStr}'. ` +
            `Keeping the registered path. Remove the stale row or rename the map entry to fix.`,
        );
      }
      continue;
    }
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
 * Phase 2B.1 m6 — prune `default-N` orphan rows from prior runs whose
 * path no longer matches `defaultProjectPath` AND that have no task or
 * worker references. Stale rows otherwise accumulate when the cwd
 * shifts across restarts (running `symphony mcp-server` from different
 * folders against the same SQLite DB).
 *
 * Conservative: only `default-N` (N ≥ 2) — the bare `default` row is
 * never pruned automatically. User-named projects are never touched.
 * If both stores agree there are zero references, the row is removed.
 *
 * Race safety: this runs synchronously during `startOrchestratorServer`
 * BEFORE any tools register, so no MCP/RPC caller can write tasks or
 * workers concurrently. A future refactor that moves tool registration
 * earlier in the boot sequence MUST preserve that invariant or move
 * this prune step to run after the registration window closes.
 */
function pruneOrphanDefaultProjects(
  projectStore: ProjectStore,
  taskStore: TaskStore,
  workerStore: WorkerStore | undefined,
  defaultProjectPath: string,
): void {
  const orphanCandidates = projectStore
    .list()
    .filter((p) => /^default-\d+$/.test(p.name))
    .filter((p) => path.resolve(p.path) !== defaultProjectPath);
  for (const p of orphanCandidates) {
    const taskRefs = taskStore.list({ projectId: p.id }).length;
    const workerRefs = workerStore ? workerStore.list({ projectId: p.id }).length : 0;
    if (taskRefs === 0 && workerRefs === 0) {
      projectStore.delete(p.id);
    }
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
