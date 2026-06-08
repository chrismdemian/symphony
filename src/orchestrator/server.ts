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
import type { ExternalLinkStore } from '../state/external-link-store.js';
import { MemoryExternalLinkStore } from '../state/external-link-store.js';
import { SqliteExternalLinkStore } from '../state/sqlite-external-link-store.js';
import type { AutomationStore } from '../state/automation-store.js';
import { InMemoryAutomationStore } from '../state/automation-store.js';
import { SqliteAutomationStore } from '../state/sqlite-automation-store.js';
import { SagaRegistry } from '../state/saga-registry.js';
import { SqliteSagaStore } from '../state/sqlite-saga-store.js';
import { createSagaRollupListener } from '../state/saga-rollup.js';
import type { SagaStore } from '../state/saga-types.js';
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
import { loadBundledDroids } from '../droids/bundled.js';
import { symphonyDataDir } from '../utils/config.js';
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
import {
  makeCreateAutomationTool,
  makeListAutomationsTool,
  makeRemoveAutomationTool,
  makeRunAutomationTool,
  makeSetAutomationEnabledTool,
} from './tools/automation-tools.js';
import { makeSyncNotionTool } from './tools/sync-notion.js';
import {
  createNotionConnectorFromDisk,
  type NotionConnectorHandle,
} from '../integrations/notion.js';
import { NOTION_INTEGRATION } from '../integrations/notion-config.js';
import { makeSyncObsidianTool } from './tools/sync-obsidian.js';
import {
  createObsidianConnectorFromDisk,
  type ObsidianConnectorHandle,
} from '../integrations/obsidian.js';
import { loadObsidianConfig, OBSIDIAN_INTEGRATION } from '../integrations/obsidian-config.js';
import { ObsidianVaultWatcher } from '../integrations/obsidian-watcher.js';
import { makeSyncIssuesTool } from './tools/make-sync-issues.js';
import { makeIssueWritebackRef } from './issue-writeback.js';
import type { IssueConnectorHandle } from '../integrations/issue-connector.js';
import { createLinearConnectorFromDisk } from '../integrations/linear.js';
import { LINEAR_INTEGRATION } from '../integrations/linear-config.js';
import { createGitHubConnectorFromDisk } from '../integrations/github.js';
import { GITHUB_INTEGRATION } from '../integrations/github-config.js';
import { createJiraConnectorFromDisk } from '../integrations/jira.js';
import { JIRA_INTEGRATION } from '../integrations/jira-config.js';
import { createGitLabConnectorFromDisk } from '../integrations/gitlab.js';
import { GITLAB_INTEGRATION } from '../integrations/gitlab-config.js';
import { createPlainConnectorFromDisk } from '../integrations/plain.js';
import { PLAIN_INTEGRATION } from '../integrations/plain-config.js';
import { createForgejoConnectorFromDisk } from '../integrations/forgejo.js';
import { FORGEJO_INTEGRATION } from '../integrations/forgejo-config.js';
import { makeTaskNotesTool } from './tools/task-notes.js';
import { makeSetActiveProjectTool } from './tools/set-active-project.js';
import { makeCreateSagaTool } from './tools/create-saga.js';
import { makeUpdateSagaTool } from './tools/update-saga.js';
import { makeListSagasTool } from './tools/list-sagas.js';
import { makeGetSagaTool } from './tools/get-saga.js';
import { createTaskNotesMirrorQueue } from '../state/task-notes-mirror-queue.js';
import { makeAskUserTool } from './tools/ask-user.js';
import { makeReviewDiffTool } from './tools/review-diff.js';
import { makeResearchWaveTool } from './tools/research-wave.js';
import { makeGlobalStatusTool } from './tools/global-status.js';
import { makeAuditChangesTool } from './tools/audit-changes.js';
import { makeVerifyUiTool } from './tools/verify-ui.js';
import { makeFinalizeTool } from './tools/finalize.js';
import { defaultOneShotRunner, type OneShotRunner } from './one-shot.js';
import type { AutonomyTier, CapabilityNotice, DispatchContext, ToolMode } from './types.js';
import { createWorkerLifecycle, type WorkerLifecycleHandle } from './worker-lifecycle.js';
import { WorkerRegistry } from './worker-registry.js';
import { routeWorkerOpenQuestions } from './open-questions-router.js';
import { WorkerEventBroker } from '../rpc/event-broker.js';
import {
  generateRpcToken,
  writeRpcDescriptor,
  deleteRpcDescriptor,
  defaultRpcTokenFilePath,
} from '../rpc/auth.js';
import { startRpcServer, type RpcServerHandle } from '../rpc/server.js';
import { createSymphonyRouter } from '../rpc/router-impl.js';
import { applyPatchToDisk, loadConfig } from '../utils/config.js';
import { readProjectConfig, readSymphonyConfig } from '../worktree/symphony-config.js';
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
import { createAutomationsBroker, type AutomationsBroker } from './automations-broker.js';
import { AutomationScheduler } from './automation-scheduler.js';
import { AutomationTriggerEngine } from './automation-trigger-engine.js';
import {
  makeIssueTriggerSource,
  type TriggerSource,
} from './automation-trigger-source.js';
import * as gitOps from './git-ops.js';
import type {
  AutoMergeBroker,
  AutoMergeDispatcherHandle,
} from './auto-merge-types.js';
import {
  SqliteAuditStore,
  clampAuditLimit,
  clampAuditOffset,
} from '../state/sqlite-audit-store.js';
import type {
  AuditAppendInput,
  AuditEntry,
  AuditKind,
  AuditSeverity,
  AuditStore,
} from '../state/audit-store.js';
import { createAuditLogger } from '../audit/logger.js';
import { createAuditFileSink } from '../audit/file-sink.js';
import { PluginHost } from '../plugins/host.js';
import { SqlitePluginStore } from '../plugins/store.js';
import { createPluginAdmin } from '../plugins/admin.js';
import type { AuditLogger } from '../audit/types.js';
import type { ToolAuditRecord, ToolAuditSink } from './dispatch.js';
import type { WorkerStatus } from '../workers/types.js';
import type { WorkerRecord } from './worker-registry.js';
import type { QuestionRecord } from '../state/question-registry.js';
import type { AutoMergeEvent } from './auto-merge-types.js';
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
  /**
   * Phase 5E — override the saga store. Defaults to a SQLite-backed
   * `SqliteSagaStore` when `database` is provided, else an in-memory
   * `SagaRegistry`. The rollup listener (`createSagaRollupListener`) is
   * always composed alongside the task-ready listener on
   * `taskStore.onTaskStatusChange`.
   */
  sagaStore?: SagaStore;
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
  /**
   * Phase 8D.1 — Automation scheduler activation. When `enabled: true` (set
   * only by the real CLI boot path) AND `plugins?.enabled !== true` (the
   * EXACTLY-ONE-SCHEDULER invariant — runs in the bootstrap Process B, never
   * Maestro's MCP child Process C) AND a persistent `database` exists, the
   * server starts an {@link AutomationScheduler} that ticks due automations
   * into `'running'` run logs the launcher delivers to Maestro. Default off.
   */
  automations?: { enabled?: boolean };
  /** Override / inject the automation store. Test seam (bypasses SQLite). */
  automationStore?: AutomationStore;
  /** Override / inject the automation scheduler. Test seam. */
  automationScheduler?: AutomationScheduler;
  /** Override / inject the automations broker. Test seam. */
  automationsBroker?: AutomationsBroker;
  /**
   * Phase 8D.1 test seam — override the scheduler tick interval (ms). Lets a
   * scenario drive ticks fast without the 30s production cadence. Ignored
   * when `automationScheduler` is injected directly.
   */
  automationTickIntervalMs?: number;
  /**
   * Phase 8D.2 — Override / inject the automation trigger engine. Test seam
   * (bypasses connector-built sources). Runs under the same gating as the
   * scheduler (Process B only, automations enabled).
   */
  automationTriggerEngine?: AutomationTriggerEngine;
  /**
   * Phase 8D.2 test seam — inject the trigger-source map directly (real engine,
   * fake sources). Ignored when `automationTriggerEngine` is injected. When
   * omitted, the map is built from the active 8C connectors.
   */
  automationTriggerSources?: ReadonlyMap<string, TriggerSource>;
  /**
   * Phase 8D.2 test seam — override the trigger poll interval + warm-up delay
   * (ms). Set huge so the auto-timer never fires and polls are driven manually
   * via the handle. Ignored when `automationTriggerEngine` is injected.
   */
  automationTriggerPollIntervalMs?: number;
  automationTriggerWarmupMs?: number;
  /**
   * Phase 3R — override the audit store. Test seam: pass an in-memory
   * fake to assert audit rows without touching SQLite. Defaults to a
   * SqliteAuditStore when `database` is provided.
   */
  auditStore?: AuditStore;
  /**
   * Phase 3R — override the audit logger. Test seam: pass a stub
   * `AuditLogger` to bypass file IO entirely. Defaults to a real logger
   * wrapping `auditStore` + a flat-file sink at `~/.symphony/audit.log`.
   */
  auditLogger?: AuditLogger;
  /**
   * Phase 3R — override the file path for the flat-file audit log
   * mirror. Test seam: tests pass a tmp path to keep ~/.symphony
   * untouched. Defaults to `~/.symphony/audit.log`.
   */
  auditFilePath?: string;
  /**
   * Phase 7A — plugin framework activation. When `enabled: true` (set
   * ONLY by Maestro's MCP child via the `--plugins` arg, NOT the bootstrap
   * RPC server) AND the user's `pluginsEnabled` config master switch is
   * true AND a `database` is present, the orchestrator constructs a
   * `PluginHost` that spawns one MCP client per enabled plugin and
   * registers their tools as namespaced proxies. Default off — the
   * bootstrap RPC server never spawns plugins, so plugin subprocesses are
   * not double-spawned. Test seam: pass `{ enabled: true }` with a
   * `database` to exercise the host.
   */
  plugins?: { enabled?: boolean };
  /**
   * Phase 8A — Notion integration activation. When `enabled: true` (set
   * only by the real CLI boot paths, NEVER by tests) and no
   * `notionConnector` is injected, the server reads `~/.symphony/
   * integrations/notion.json` + token and constructs a `NotionConnector`
   * if Notion is configured. Gating off `enabled` keeps tests from
   * accidentally reading the user's real Notion config off disk. The
   * `sync_notion` tool + the terminal-status writeback hook are wired only
   * when a connector exists. Test seam: inject `notionConnector` directly.
   */
  notion?: { enabled?: boolean };
  /** Override / inject the Notion connector. Test seam (bypasses disk read). */
  notionConnector?: NotionConnectorHandle;
  /**
   * Phase 8B — Obsidian integration activation. When `enabled: true` (set
   * only by the real CLI boot paths, NEVER by tests) and no
   * `obsidianConnector` is injected, the server reads `~/.symphony/
   * integrations/obsidian.json` and constructs an `ObsidianConnector` if a
   * vault is configured. The `sync_obsidian` tool, the checkbox-writeback
   * hook, and the live vault watcher are wired only when a connector exists.
   * Test seam: inject `obsidianConnector` directly.
   */
  obsidian?: { enabled?: boolean };
  /** Override / inject the Obsidian connector. Test seam (bypasses disk read). */
  obsidianConnector?: ObsidianConnectorHandle;
  /**
   * Phase 8B test seam — disable the live chokidar watcher even when an
   * Obsidian connector is present (unit/integration tests that don't want a
   * real fs watcher). Production leaves this undefined and honors the config's
   * `watch` flag.
   */
  obsidianWatch?: boolean;
  /**
   * Phase 8C — Linear integration activation. When `enabled: true` (set only
   * by the real CLI boot paths, NEVER by tests) and no `linearConnector` is
   * injected, the server reads the stored Linear API key (+ optional
   * `linear.json`) and constructs a `LinearConnector` when a key is present.
   * The `sync_linear` tool + the terminal-status writeback hook are wired only
   * when a connector exists. Test seam: inject `linearConnector` directly.
   */
  linear?: { enabled?: boolean };
  /** Override / inject the Linear connector. Test seam (bypasses disk read). */
  linearConnector?: IssueConnectorHandle;
  /**
   * Phase 8C.2 — GitHub Issues integration activation. When `enabled: true` (set
   * only by the real CLI boot paths, NEVER by tests) and no `githubConnector` is
   * injected, the server reads the stored GitHub token (+ `github.json` repos)
   * and constructs a `GitHubConnector` when a token AND at least one repo are
   * present. The `sync_github` tool + the terminal-status writeback hook
   * (comment + close) are wired only when a connector exists. Test seam: inject
   * `githubConnector` directly.
   */
  github?: { enabled?: boolean };
  /** Override / inject the GitHub connector. Test seam (bypasses disk read). */
  githubConnector?: IssueConnectorHandle;
  /**
   * Phase 8C.3 — Jira integration activation. When `enabled: true` (set only by
   * the real CLI boot paths, NEVER by tests) and no `jiraConnector` is injected,
   * the server reads the stored Jira token (+ `jira.json` site URL + email) and
   * constructs a `JiraConnector` when a token, site URL, AND email are present.
   * The `sync_jira` tool + the terminal-status writeback hook (comment +
   * transition to Done) are wired only when a connector exists. Test seam:
   * inject `jiraConnector` directly.
   */
  jira?: { enabled?: boolean };
  /** Override / inject the Jira connector. Test seam (bypasses disk read). */
  jiraConnector?: IssueConnectorHandle;
  /**
   * Phase 8C.3 — GitLab integration activation. When `enabled: true` (set only
   * by the real CLI boot paths, NEVER by tests) and no `gitlabConnector` is
   * injected, the server reads the stored GitLab token (+ `gitlab.json`
   * projects) and constructs a `GitLabConnector` when a token AND at least one
   * project are present. The `sync_gitlab` tool + the terminal-status writeback
   * hook (note + close) are wired only when a connector exists. Test seam:
   * inject `gitlabConnector` directly.
   */
  gitlab?: { enabled?: boolean };
  /** Override / inject the GitLab connector. Test seam (bypasses disk read). */
  gitlabConnector?: IssueConnectorHandle;
  /**
   * Phase 8C.4 — Plain integration activation. When `enabled: true` (set only
   * by the real CLI boot paths, NEVER by tests) and no `plainConnector` is
   * injected, the server reads the stored Plain API key (+ optional `plain.json`)
   * and constructs a `PlainConnector` (token-only activation, like Linear). The
   * `sync_plain` tool + the terminal-status writeback hook (internal note + mark
   * done) are wired only when a connector exists. Test seam: inject
   * `plainConnector` directly.
   */
  plain?: { enabled?: boolean };
  /** Override / inject the Plain connector. Test seam (bypasses disk read). */
  plainConnector?: IssueConnectorHandle;
  /**
   * Phase 8C.4 — Forgejo integration activation. When `enabled: true` (set only
   * by the real CLI boot paths, NEVER by tests) and no `forgejoConnector` is
   * injected, the server reads the stored Forgejo token (+ `forgejo.json` site
   * URL + repos) and constructs a `ForgejoConnector` when a token, site URL, AND
   * at least one repo are present. The `sync_forgejo` tool + the terminal-status
   * writeback hook (comment + close) are wired only when a connector exists. Test
   * seam: inject `forgejoConnector` directly.
   */
  forgejo?: { enabled?: boolean };
  /** Override / inject the Forgejo connector. Test seam (bypasses disk read). */
  forgejoConnector?: IssueConnectorHandle;
  /**
   * Phase 8A — override the task↔external-source link store. Defaults to
   * SQLite-backed when `database` is provided, else in-memory. Used for
   * sync dedup + the Notion / Obsidian / Linear / GitHub status writeback.
   */
  externalLinkStore?: ExternalLinkStore;
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
  /** Phase 8A — task↔external-source links (Notion sync dedup + writeback). */
  externalLinkStore: ExternalLinkStore;
  /** Phase 8A — present when Notion is configured + activated. */
  notionConnector?: NotionConnectorHandle;
  /** Phase 8B — present when Obsidian is configured + activated. */
  obsidianConnector?: ObsidianConnectorHandle;
  /** Phase 8C — present when Linear is configured + activated. */
  linearConnector?: IssueConnectorHandle;
  /** Phase 8C.2 — present when GitHub is configured + activated. */
  githubConnector?: IssueConnectorHandle;
  /** Phase 8C.3 — present when Jira is configured + activated. */
  jiraConnector?: IssueConnectorHandle;
  /** Phase 8C.3 — present when GitLab is configured + activated. */
  gitlabConnector?: IssueConnectorHandle;
  /** Phase 8C.4 — present when Plain is configured + activated. */
  plainConnector?: IssueConnectorHandle;
  /** Phase 8C.4 — present when Forgejo is configured + activated. */
  forgejoConnector?: IssueConnectorHandle;
  /** Phase 5E — exposed for tests + tools that need to read saga membership. */
  sagaStore: SagaStore;
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
  /** Phase 8D.1 — exposed for tests + the RPC layer's `automations.*`. */
  automationStore: AutomationStore;
  /** Phase 8D.1 — exposed for tests that subscribe to scheduler wake hints. */
  automationsBroker: AutomationsBroker;
  /** Phase 8D.1 — present when the scheduler was activated (Process B, enabled). */
  automationScheduler?: AutomationScheduler;
  /** Phase 8D.2 — present when the trigger engine was activated (Process B, enabled). */
  automationTriggerEngine?: AutomationTriggerEngine;
  /** Phase 3R — exposed for tests + the RPC layer's `audit.list`. */
  auditLogger: AuditLogger;
  /** Phase 3R — exposed for tests + the RPC layer's `audit.list`. */
  auditStore: AuditStore;
  /** Phase 7A — present when the plugin host was activated (Maestro MCP child + master switch on). */
  pluginHost?: PluginHost;
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

  // Phase 3R — audit infrastructure. SQLite-backed when `database` is
  // provided, in-memory otherwise (test fakes). The logger sanitizes
  // payloads + fans to an optional flat-file sink. File sink is
  // opt-out via explicit `options.auditLogger` (in which case the
  // caller wires their own sinks).
  const auditStore: AuditStore =
    options.auditStore ??
    (options.database ? new SqliteAuditStore(options.database.db) : createMemoryAuditStore());
  const auditLogger: AuditLogger =
    options.auditLogger ??
    createAuditLogger({
      store: auditStore,
      fileSink: createAuditFileSink(
        options.auditFilePath !== undefined ? { filePath: options.auditFilePath } : {},
      ),
    });

  // Phase 3R — translate `wrapToolHandler`'s ToolAuditRecord into the
  // generic AuditAppendInput. The args payload is passed through the
  // logger's sanitizer (defense in depth — args may carry secrets
  // even though tools should never accept them by design). `outcome`
  // maps to one of three AuditKind values.
  const toolAuditSink: ToolAuditSink = (record: ToolAuditRecord): void => {
    const kind: AuditKind =
      record.outcome === 'ok'
        ? 'tool_called'
        : record.outcome === 'denied'
          ? 'tool_denied'
          : 'tool_error';
    const severity: AuditSeverity =
      record.outcome === 'ok' ? 'info' : record.outcome === 'denied' ? 'warn' : 'error';
    const argsJson = JSON.stringify(record.args);
    const truncatedArgs = argsJson.length > 1024 ? argsJson.slice(0, 1024) + '…' : argsJson;
    const headline =
      record.outcome === 'ok'
        ? `tool ${record.name} · tier ${record.tier} · ok`
        : record.outcome === 'denied'
          ? `tool ${record.name} · tier ${record.tier} · denied (${record.reason ?? 'no reason'})`
          : `tool ${record.name} · tier ${record.tier} · error (${record.reason ?? 'unknown'})`;
    auditLogger.append(
      {
        ts: new Date().toISOString(),
        kind,
        severity,
        toolName: record.name,
        headline,
        payload: {
          scope: record.scope,
          capabilities: record.capabilities,
          tier: record.tier,
          mode: record.mode,
          args: truncatedArgs,
          ...(record.reason !== undefined ? { reason: record.reason } : {}),
        },
      },
      {
        // Public protocol metadata — keep readable.
        rawKeys: ['scope', 'mode', 'tier', 'capabilities', 'reason'],
      },
    );
  };

  const registry = new ToolRegistry({
    server,
    mode,
    safety,
    capabilityEvaluator,
    getContext: () => context,
    noticeSink,
    auditSink: toolAuditSink,
  });

  // Phase 7A — holder for the plugin host. Constructed late (after all
  // built-in tools register), but the worker/task status callbacks below
  // close over this ref so events fan out to plugins once the host fills
  // it in. `current` stays undefined when plugins aren't activated.
  const pluginHostRef: { current?: PluginHost } = {};

  const defaultProjectPath = path.resolve(options.defaultProjectPath ?? process.cwd());
  const projects = options.projects ?? {};

  // Phase 5A — merge `.symphony.json` `project` overlay into caller
  // configs once, so both SQLite + in-memory seeding paths see the
  // unified shape. Caller's `options.projectConfigs[name]` still wins
  // over file values per the documented precedence.
  const effectiveProjectConfigs = mergeProjectConfigsWithFiles(projects, options.projectConfigs);

  const projectStore: ProjectStore =
    options.projectStore ??
    (() => {
      if (options.database) {
        const store = new SqliteProjectStore(options.database.db);
        seedProjectsFromMap(store, projects, effectiveProjectConfigs);
        return store;
      }
      const store = projectRegistryFromMap(projects, {
        configs: effectiveProjectConfigs as Record<string, Partial<ProjectRecord>>,
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
  // Phase 5C — fire-and-forget disk mirror for task notes. SQL is source
  // of truth; the mirror exists so workers in worktrees can `Read` prior
  // context and humans can inspect notes outside Symphony. Errors are
  // swallowed inside `mirrorTaskNotes` (returns `skipReason`) so a fs
  // failure never poisons SQL writes. We resolve the project path
  // lazily on each callback so registry/seed timing doesn't matter.
  //
  // Per-task serialization (`createTaskNotesMirrorQueue`) prevents
  // back-to-back appends from racing on the same target file: each
  // task gets its own promise chain so `mkdir → writeFile → rename`
  // cycles never interleave.
  const taskNotesMirrorQueue = createTaskNotesMirrorQueue();
  const taskNotesOnAppend = (snapshot: TaskSnapshot): void => {
    const proj = projectStore.get(snapshot.projectId);
    const projectPath = proj?.path ?? null;
    void taskNotesMirrorQueue
      .enqueue({
        projectPath,
        taskId: snapshot.id,
        notes: snapshot.notes,
      })
      .catch(() => {
        // mirror is best-effort; never re-throw.
      });
  };
  // Phase 5E — saga store + rollup listener. The store is constructed
  // BEFORE the task store so the rollup listener can close over it.
  // The rollup listener composes with the task-ready listener via a
  // simple fan-out (both fire on every status change).
  const sagaStore: SagaStore =
    options.sagaStore ??
    (options.database
      ? new SqliteSagaStore(options.database.db, { projectStore })
      : new SagaRegistry({ projectStore }));
  const sagaRollupListener = createSagaRollupListener({ sagaStore });
  // Phase 8A — Notion status writeback hook. Filled in after the connector
  // is constructed (it's async + gated). When a task with a Notion external
  // link reaches a terminal status, push that status back to the Notion
  // page. Fire-and-forget + internally guarded — never throws into the
  // event bus (mirrors plugin dispatch).
  const notionWritebackRef: { current?: (snapshot: TaskSnapshot) => void } = {};
  // Phase 8B — Obsidian checkbox writeback hook (same shape as Notion's).
  const obsidianWritebackRef: { current?: (snapshot: TaskSnapshot) => void } = {};
  // Phase 8C — Linear issue writeback hook (same shape; built by makeIssueWritebackRef).
  const linearWritebackRef: { current?: (snapshot: TaskSnapshot) => void } = {};
  // Phase 8C.2 — GitHub issue writeback hook (comment + close; built by makeIssueWritebackRef).
  const githubWritebackRef: { current?: (snapshot: TaskSnapshot) => void } = {};
  // Phase 8C.3 — Jira issue writeback hook (comment + transition to Done; built by makeIssueWritebackRef).
  const jiraWritebackRef: { current?: (snapshot: TaskSnapshot) => void } = {};
  // Phase 8C.3 — GitLab issue writeback hook (note + close; built by makeIssueWritebackRef).
  const gitlabWritebackRef: { current?: (snapshot: TaskSnapshot) => void } = {};
  // Phase 8C.4 — Plain issue writeback hook (internal note + mark done; built by makeIssueWritebackRef).
  const plainWritebackRef: { current?: (snapshot: TaskSnapshot) => void } = {};
  // Phase 8C.4 — Forgejo issue writeback hook (comment + close; built by makeIssueWritebackRef).
  const forgejoWritebackRef: { current?: (snapshot: TaskSnapshot) => void } = {};
  const fanOutTaskStatusChange = (snapshot: TaskSnapshot): void => {
    taskReadyOnTaskStatusChange(snapshot);
    sagaRollupListener(snapshot);
    // Phase 7A — fan task terminal transitions out to subscribed plugins.
    // `completed` → onTaskCompleted, `failed` → onTaskFailed; other
    // statuses produce no event. Fire-and-forget inside dispatchEvent.
    if (snapshot.status === 'completed' || snapshot.status === 'failed') {
      pluginHostRef.current?.dispatchEvent(
        snapshot.status === 'completed' ? 'onTaskCompleted' : 'onTaskFailed',
        { taskId: snapshot.id, projectId: snapshot.projectId, status: snapshot.status },
      );
      notionWritebackRef.current?.(snapshot);
      obsidianWritebackRef.current?.(snapshot);
      linearWritebackRef.current?.(snapshot);
      githubWritebackRef.current?.(snapshot);
      jiraWritebackRef.current?.(snapshot);
      gitlabWritebackRef.current?.(snapshot);
      plainWritebackRef.current?.(snapshot);
      forgejoWritebackRef.current?.(snapshot);
    }
  };
  // Phase 7B.3 — fan task creation out to subscribed plugins (onTaskCreated).
  // Fires for every TaskStore.create caller uniformly. Payload mirrors the
  // SDK's TaskCreatedEvent field set byte-for-byte.
  const fanOutTaskCreated = (snapshot: TaskSnapshot): void => {
    pluginHostRef.current?.dispatchEvent('onTaskCreated', {
      taskId: snapshot.id,
      projectId: snapshot.projectId,
      description: snapshot.description,
      status: snapshot.status,
    });
  };
  const taskStore: TaskStore =
    options.taskStore ??
    (options.database
      ? new SqliteTaskStore(options.database.db, {
          onTaskStatusChange: fanOutTaskStatusChange,
          onNotesAppended: taskNotesOnAppend,
          onTaskCreated: fanOutTaskCreated,
        })
      : new TaskRegistry({
          projectStore,
          onTaskStatusChange: fanOutTaskStatusChange,
          onNotesAppended: taskNotesOnAppend,
          onTaskCreated: fanOutTaskCreated,
        }));
  // Phase 8A — task↔external-source link store. Always constructed (cheap;
  // dedup + writeback both need it); SQLite-backed when a database is
  // present, in-memory otherwise (tests / `--in-memory`).
  const externalLinkStore: ExternalLinkStore =
    options.externalLinkStore ??
    (options.database
      ? new SqliteExternalLinkStore(options.database.db)
      : new MemoryExternalLinkStore());
  // Phase 8D.1 — automation store. SQLite-backed when a database is present,
  // in-memory otherwise. Backs the scheduler (this process) AND the
  // `automations.*` RPC the launcher's injector pulls from.
  const automationStore: AutomationStore =
    options.automationStore ??
    (options.database
      ? new SqliteAutomationStore(options.database.db)
      : new InMemoryAutomationStore());
  // Phase 8A — Notion connector. Injected (test seam) or auto-constructed
  // from disk when activated by the CLI boot path (`notion.enabled`).
  // Gating off `enabled` keeps tests from reading the user's real Notion
  // config. Undefined when Notion isn't configured — the `sync_notion`
  // tool + writeback hook are wired only when a connector exists.
  const notionLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    const line = `[symphony] notion: ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    // info stays quiet — writeback success etc. shouldn't spam stderr.
  };
  const notionConnector: NotionConnectorHandle | undefined =
    options.notionConnector ??
    (options.notion?.enabled === true
      ? await createNotionConnectorFromDisk({ log: notionLog })
      : undefined);
  if (notionConnector !== undefined) {
    notionWritebackRef.current = (snapshot: TaskSnapshot): void => {
      if (snapshot.status !== 'completed' && snapshot.status !== 'failed') return;
      const link = externalLinkStore
        .listByTaskId(snapshot.id)
        .find((l) => l.source === NOTION_INTEGRATION);
      if (link === undefined) return;
      void notionConnector.writeBackStatus(link.externalId, snapshot.status).then(
        (result) => {
          if (result.written) {
            notionLog('info', `page ${link.externalId} → ${result.value}`);
          }
        },
        (err: unknown) => {
          notionLog(
            'warn',
            `writeback failed for page ${link.externalId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        },
      );
    };
  }
  // Phase 8B — Obsidian connector. Injected (test seam) or auto-constructed
  // from disk when activated by the CLI boot path (`obsidian.enabled`). No
  // token — a vault is a local folder. Undefined when Obsidian isn't
  // configured; the `sync_obsidian` tool, the checkbox-writeback hook, and the
  // vault watcher are wired only when a connector exists. The watcher itself is
  // started later (it needs `resolveProjectPath`, defined below).
  const obsidianLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    const line = `[symphony] obsidian: ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    // info stays quiet — TUI owns stdout.
  };
  const obsidianConnector: ObsidianConnectorHandle | undefined =
    options.obsidianConnector ??
    (options.obsidian?.enabled === true
      ? await createObsidianConnectorFromDisk({ log: obsidianLog })
      : undefined);
  if (obsidianConnector !== undefined) {
    obsidianWritebackRef.current = (snapshot: TaskSnapshot): void => {
      if (snapshot.status !== 'completed' && snapshot.status !== 'failed') return;
      const link = externalLinkStore
        .listByTaskId(snapshot.id)
        .find((l) => l.source === OBSIDIAN_INTEGRATION);
      if (link === undefined) return;
      void obsidianConnector.writeBackStatus(link.externalId, snapshot.status).then(
        (result) => {
          if (result.written) {
            obsidianLog('info', `task ${link.externalId} → [${result.value}]`);
          } else if (result.code !== 'skipped') {
            // not-found (locator drift — the task line was edited/deleted in
            // the vault) or error: surface it, never fail silently (audit M3).
            obsidianLog('warn', `writeback skipped for ${link.externalId}: ${result.reason}`);
          }
        },
        (err: unknown) => {
          obsidianLog(
            'warn',
            `writeback failed for ${link.externalId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        },
      );
    };
  }
  // Started below (needs `resolveProjectPath`); stopped in `close()`.
  let obsidianWatcher: ObsidianVaultWatcher | undefined;
  // Phase 8D.1 — automation scheduler. Started below (after the dispatch
  // context cursor exists); stopped first in `close()`.
  let automationScheduler: AutomationScheduler | undefined;
  // Phase 8D.2 — automation trigger engine. Built from the active 8C
  // connectors (below, after they're constructed), started + stopped
  // alongside the scheduler.
  let automationTriggerEngine: AutomationTriggerEngine | undefined;
  // Phase 8C — Linear connector. Injected (test seam) or auto-constructed from
  // the stored API key when activated by the CLI boot path (`linear.enabled`).
  // Undefined when no key is stored — the `sync_linear` tool + writeback hook
  // wire up only when a connector exists. Construction is lazy (no network
  // until a tool / writeback fires); gating off `enabled` keeps tests from
  // reading the user's real keychain/config.
  const linearLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    const line = `[symphony] linear: ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    // info stays quiet — TUI owns stdout.
  };
  const linearConnector: IssueConnectorHandle | undefined =
    options.linearConnector ??
    (options.linear?.enabled === true
      ? await createLinearConnectorFromDisk({ log: linearLog })
      : undefined);
  if (linearConnector !== undefined) {
    linearWritebackRef.current = makeIssueWritebackRef({
      connector: linearConnector,
      source: LINEAR_INTEGRATION,
      externalLinkStore,
      log: linearLog,
    });
  }
  // Phase 8C.2 — GitHub connector. Injected (test seam) or auto-constructed from
  // the stored token + `github.json` repos when activated by the CLI boot path
  // (`github.enabled`). Undefined when no token OR no repos — the `sync_github`
  // tool + writeback hook wire up only when a connector exists. Same lazy /
  // double-construction-is-safe property as Linear/Notion/Obsidian.
  const githubLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    const line = `[symphony] github: ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    // info stays quiet — TUI owns stdout.
  };
  const githubConnector: IssueConnectorHandle | undefined =
    options.githubConnector ??
    (options.github?.enabled === true
      ? await createGitHubConnectorFromDisk({ log: githubLog })
      : undefined);
  if (githubConnector !== undefined) {
    githubWritebackRef.current = makeIssueWritebackRef({
      connector: githubConnector,
      source: GITHUB_INTEGRATION,
      externalLinkStore,
      log: githubLog,
    });
  }
  // Phase 8C.3 — Jira connector. Injected (test seam) or auto-constructed from
  // the stored token + `jira.json` site URL + email when activated by the CLI
  // boot path (`jira.enabled`). Undefined when no token OR no site URL/email —
  // the `sync_jira` tool + writeback hook wire up only when a connector exists.
  const jiraLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    const line = `[symphony] jira: ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    // info stays quiet — TUI owns stdout.
  };
  const jiraConnector: IssueConnectorHandle | undefined =
    options.jiraConnector ??
    (options.jira?.enabled === true
      ? await createJiraConnectorFromDisk({ log: jiraLog })
      : undefined);
  if (jiraConnector !== undefined) {
    jiraWritebackRef.current = makeIssueWritebackRef({
      connector: jiraConnector,
      source: JIRA_INTEGRATION,
      externalLinkStore,
      log: jiraLog,
    });
  }
  // Phase 8C.3 — GitLab connector. Injected (test seam) or auto-constructed from
  // the stored token + `gitlab.json` projects when activated by the CLI boot
  // path (`gitlab.enabled`). Undefined when no token OR no projects — the
  // `sync_gitlab` tool + writeback hook wire up only when a connector exists.
  const gitlabLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    const line = `[symphony] gitlab: ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    // info stays quiet — TUI owns stdout.
  };
  const gitlabConnector: IssueConnectorHandle | undefined =
    options.gitlabConnector ??
    (options.gitlab?.enabled === true
      ? await createGitLabConnectorFromDisk({ log: gitlabLog })
      : undefined);
  if (gitlabConnector !== undefined) {
    gitlabWritebackRef.current = makeIssueWritebackRef({
      connector: gitlabConnector,
      source: GITLAB_INTEGRATION,
      externalLinkStore,
      log: gitlabLog,
    });
  }
  // Phase 8C.4 — Plain connector. Injected (test seam) or auto-constructed from
  // the stored API key (+ optional plain.json) when activated by the CLI boot
  // path (`plain.enabled`). Token-only activation (like Linear) — undefined when
  // no token. The `sync_plain` tool + the note+done writeback hook wire up only
  // when a connector exists.
  const plainLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    const line = `[symphony] plain: ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    // info stays quiet — TUI owns stdout.
  };
  const plainConnector: IssueConnectorHandle | undefined =
    options.plainConnector ??
    (options.plain?.enabled === true
      ? await createPlainConnectorFromDisk({ log: plainLog })
      : undefined);
  if (plainConnector !== undefined) {
    plainWritebackRef.current = makeIssueWritebackRef({
      connector: plainConnector,
      source: PLAIN_INTEGRATION,
      externalLinkStore,
      log: plainLog,
    });
  }
  // Phase 8C.4 — Forgejo connector. Injected (test seam) or auto-constructed from
  // the stored token + `forgejo.json` site URL + repos when activated by the CLI
  // boot path (`forgejo.enabled`). Undefined when no token / no site URL / no
  // repos — the `sync_forgejo` tool + writeback hook wire up only when a
  // connector exists.
  const forgejoLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    const line = `[symphony] forgejo: ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    // info stays quiet — TUI owns stdout.
  };
  const forgejoConnector: IssueConnectorHandle | undefined =
    options.forgejoConnector ??
    (options.forgejo?.enabled === true
      ? await createForgejoConnectorFromDisk({ log: forgejoLog })
      : undefined);
  if (forgejoConnector !== undefined) {
    forgejoWritebackRef.current = makeIssueWritebackRef({
      connector: forgejoConnector,
      source: FORGEJO_INTEGRATION,
      externalLinkStore,
      log: forgejoLog,
    });
  }
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
          onQuestionEnqueued: (record) => {
            notificationDispatcher.onQuestion(record);
            auditQuestionAsked(auditLogger, record);
          },
          onQuestionAnswered: (record) => {
            autoMergeDispatcherRef.current?.onQuestionAnswered(record);
            auditQuestionAnswered(auditLogger, record);
          },
        })
      : new QuestionRegistry({
          onQuestionEnqueued: (record) => {
            notificationDispatcher.onQuestion(record);
            auditQuestionAsked(auditLogger, record);
          },
          onQuestionAnswered: (record) => {
            autoMergeDispatcherRef.current?.onQuestionAnswered(record);
            auditQuestionAnswered(auditLogger, record);
          },
        }));
  const waveStore: WaveStore =
    options.waveStore ??
    (options.database ? new SqliteWaveStore(options.database.db) : new WaveRegistry());

  // Phase 5D — active-project cursor. `null` means the resolver falls
  // back to the boot-time default (defaultProjectPath). Tool calls that
  // explicitly pass `project:` are NEVER routed through this cursor —
  // explicit-arg always wins, matching the existing semantics.
  //
  // The cursor is mutated by:
  //   - `setDispatchActiveProject` (wired into RouterDeps below)
  //   - `set_active_project` MCP tool (Maestro-side handle plumbed via
  //     `lifecycleOptions.activeProjectController` further down)
  //   - boot-time `resolveBootActiveProject()` (after ensureDefault).
  //
  // Stored as the registered project's NAME (mirrors the config field
  // + `symphony list` + the MCP tool input). Path is resolved on read
  // so a registered project that gets re-registered at a different
  // path still routes correctly without cursor reload.
  let activeProjectCursor: string | null = null;

  /**
   * Look up the path of the project named by the cursor, if any. Returns
   * undefined when the cursor is null OR when the named project no
   * longer exists (e.g. user did `symphony remove` mid-session). The
   * resolver below treats undefined as "fall through to defaultProjectPath".
   */
  const getActiveProjectPath = (): string | undefined => {
    if (activeProjectCursor === null) return undefined;
    const rec = projectStore.get(activeProjectCursor);
    return rec?.path;
  };

  /**
   * Phase 5D — central setter for the active-project cursor. Both the
   * `runtime.setActiveProject` RPC handler (TUI-direct) and the
   * `set_active_project` MCP tool (Maestro-driven) route through THIS
   * closure so audit + chat-row signal fire identically regardless of
   * which entry point flipped the cursor.
   *
   * Trust contract: the caller has ALREADY validated the project name
   * against `projectStore` (or passed `null` to clear). No
   * double-validation here.
   *
   * No-op when value === prev (don't emit chat rows for redundant
   * "switch to X" when we were already on X).
   */
  const setDispatchActiveProject = (value: string | null): void => {
    const prev = activeProjectCursor;
    activeProjectCursor = value;
    if (prev === value) return;
    auditLogger.append(
      {
        ts: new Date().toISOString(),
        kind: 'active_project_changed',
        severity: 'info',
        headline: `active project ${prev ?? '(none)'} → ${value ?? '(none)'}`,
        payload: { from: prev ?? null, to: value ?? null },
      },
      { rawKeys: ['from', 'to'] },
    );
    // Phase 5D — chat-row signal. Reuse CompletionSummary (3O.1 /
    // 3P precedent) with `statusKind: 'completed'` so the chat
    // bubble renders with the gold ✓ glyph. Synthetic workerId
    // mirrors 3M's `away-digest-${Date.now()}` shape; chat reducer
    // keys rows by its own turnId so workerId collisions are inert.
    // The bubble's `(project) · duration` tail is suppressed by
    // `projectName=''` AND `durationMs=null` (3M-locked Bubble
    // behavior) — the headline itself carries the project name
    // change, so the tail would be redundant.
    completionsBroker.publish({
      workerId: `active-project-${Date.now()}`,
      workerName: 'Symphony',
      projectName: '',
      statusKind: 'completed',
      durationMs: null,
      headline:
        value === null
          ? `Active project cleared (was ${prev ?? '(none)'})`
          : `Active project → ${value}`,
      ts: new Date().toISOString(),
      fallback: false,
    });
  };

  /**
   * Phase 5D — disk persistence for the active-project field. Wraps
   * `applyPatchToDisk` so the `set_active_project` MCP tool can
   * persist without importing `config.ts` directly (keeps the tool
   * test-friendly — production wires this, tests pass `vi.fn()`).
   */
  const persistActiveProject = async (project: string | null): Promise<void> => {
    await applyPatchToDisk({ activeProject: project });
  };

  const resolveProjectPath = (project?: string): string => {
    if (project !== undefined && project.length > 0) {
      const stored = projectStore.get(project);
      if (stored) return stored.path;
      // Accept absolute path fallback for Phase 5 pre-registry mode.
      if (path.isAbsolute(project)) return path.resolve(project);
      throw new Error(
        `Unknown project '${project}'. Register it via OrchestratorServerOptions.projects or pass an absolute path.`,
      );
    }
    // Phase 5D — omitted project: consult the active-project cursor
    // first. If null OR the cursor names a project that no longer
    // exists, fall back to defaultProjectPath. The fallback chain
    // mirrors the boot resolver below so mid-session removes don't
    // strand Maestro on a phantom project.
    return getActiveProjectPath() ?? defaultProjectPath;
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

  // Phase 3R — audit every auto-merge event. Single subscriber, no
  // unsubscribe needed (broker is cleared on server close).
  autoMergeBroker.subscribe((event: AutoMergeEvent) => {
    auditAutoMergeEvent(auditLogger, event);
  });

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

  // Phase 8D.1 — automations broker (scheduler → launcher wake hint). The
  // scheduler is constructed + started further below (after the dispatch
  // context cursor exists, so its capability flag can be honored). Test
  // override via `options.automationsBroker`.
  const automationsBroker: AutomationsBroker =
    options.automationsBroker ?? createAutomationsBroker();

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
  // Phase 7A — plugin master switch, read once at boot.
  let bootPluginsEnabled: boolean;
  // Phase 8D.1 — automation master switch, read once at boot.
  let bootAutomationsEnabled: boolean;
  // Phase 5D — boot-time active-project resolution. Reads
  // `config.activeProject` from disk; validates against the
  // (post-`ensureDefault`) projectStore so a project that was removed
  // out-of-band gracefully degrades to the defaultProjectPath
  // fallback. `undefined` means "no persisted preference" — the
  // cursor stays null and the resolver uses defaultProjectPath.
  let bootActiveProjectName: string | undefined;
  try {
    const bootGlobalConfig = await loadConfig();
    globalMaxWorkers = bootGlobalConfig.config.maxConcurrentWorkers;
    globalModelMode = bootGlobalConfig.config.modelMode;
    bootAwayMode = bootGlobalConfig.config.awayMode;
    bootAutonomyTier = bootGlobalConfig.config.autonomyTier;
    bootActiveProjectName = bootGlobalConfig.config.activeProject;
    bootPluginsEnabled = bootGlobalConfig.config.pluginsEnabled;
    bootAutomationsEnabled = bootGlobalConfig.config.automationsEnabled;
  } catch {
    const fallback = (await import('../utils/config-schema.js')).defaultConfig();
    globalMaxWorkers = fallback.maxConcurrentWorkers;
    globalModelMode = fallback.modelMode;
    bootAwayMode = fallback.awayMode;
    bootAutonomyTier = fallback.autonomyTier;
    bootActiveProjectName = fallback.activeProject;
    bootPluginsEnabled = fallback.pluginsEnabled;
    bootAutomationsEnabled = fallback.automationsEnabled;
  }
  // Phase 5D — initialize the active-project cursor. The cursor is the
  // CONFIG's `activeProject` when it names a known project; otherwise
  // null (resolver falls back to defaultProjectPath). We do NOT
  // auto-promote the boot default into the cursor — a null cursor is
  // semantically distinct from "user pinned the boot project." This
  // matters for `symphony list`'s `(active)` annotation: only an
  // explicit USER choice (or Maestro's `set_active_project` call)
  // marks a project active.
  if (bootActiveProjectName !== undefined) {
    const stored = projectStore.get(bootActiveProjectName);
    if (stored !== undefined) {
      activeProjectCursor = stored.name;
    }
    // else: persisted active project was removed out-of-band. Leave
    // cursor null; the resolver falls back to defaultProjectPath
    // silently. We don't audit-log on boot because the user hasn't
    // taken an action this session.
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
      // Phase 4A — source the worker prompt's `{test_cmd}` /
      // `{build_cmd}` / `{lint_cmd}` slots from the registered project.
      // Resolve by stable id first; fall back to path match for
      // unregistered absolute-path projects (projectId === null).
      // Unresolved → undefined fields → composer renders `(none)`.
      resolveProjectCommands: ({ projectPath, projectId }) => {
        let rec: ProjectRecord | undefined;
        if (projectId !== null) {
          rec = projectStore.get(projectId);
        }
        if (rec === undefined) {
          // 2A.4a-M2: normalize both sides — Win32 `C:\foo` vs `C:/foo`
          // and trailing-slash discrepancies make raw `===` miss.
          const want = path.resolve(projectPath);
          for (const p of projectStore.list()) {
            if (path.resolve(p.path) === want) {
              rec = p;
              break;
            }
          }
        }
        return {
          ...(rec?.testCommand !== undefined ? { test: rec.testCommand } : {}),
          ...(rec?.buildCommand !== undefined ? { build: rec.buildCommand } : {}),
          ...(rec?.lintCommand !== undefined ? { lint: rec.lintCommand } : {}),
          // Phase 4G.1 — also surface verifyCommand so the reviewer
          // opener + worker-common-suffix DoD block both render the real
          // command instead of `(none)`.
          ...(rec?.verifyCommand !== undefined ? { verify: rec.verifyCommand } : {}),
          // Phase 4G.2 — previewCommand for the worker DoD slot. The
          // `verify_ui` MCP tool reads it from ProjectRecord directly
          // (worker prompt vars are display-only).
          ...(rec?.previewCommand !== undefined ? { preview: rec.previewCommand } : {}),
        };
      },
      // Phase 7B.3 — fan a worker spawn out to subscribed plugins
      // (onWorkerSpawned). Fires once per spawn at `'spawning'` status;
      // payload mirrors the SDK's WorkerSpawnedEvent field set (no status).
      onWorkerSpawned: (record) => {
        pluginHostRef.current?.dispatchEvent('onWorkerSpawned', {
          workerId: record.id,
          role: record.role,
          featureIntent: record.featureIntent,
          projectId: record.projectId,
          taskId: record.taskId,
        });
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
        auditWorkerExit(auditLogger, record);
        // Phase 7A — fan a successful worker completion out to subscribed
        // plugins. Only `completed` maps to onWorkerCompleted (the 7A
        // taxonomy has no worker-failure event); the payload carries the
        // status so plugins can branch. Fire-and-forget.
        if (record.status === 'completed') {
          pluginHostRef.current?.dispatchEvent('onWorkerCompleted', {
            workerId: record.id,
            role: record.role,
            status: record.status,
            featureIntent: record.featureIntent,
            projectId: record.projectId,
            taskId: record.taskId,
          });
        }
        // Phase 4E — route the worker's `open_questions` into the 3E
        // question subsystem as advisory, auto-acknowledged entries
        // (rule #7: surfaced in History on demand, never blocking).
        // One-shot per terminal exit; resume clears the buffer so a
        // re-run routes only its fresh questions.
        routeWorkerOpenQuestions(record, questionStore);
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
  // Phase 4F.2 — load bundled droids ONCE at server boot. The
  // `design-researcher` droid (and any future bundled droid) reads its
  // body from `dist/droids/bundled/*.md` (tsup-copied subtree) with
  // `{design_catalog_dir}` substituted to the absolute vendor-store
  // path. A packaging-bug (missing bundle dir) THROWS — that's a
  // production defect, not a runtime fallback. A malformed individual
  // file is a warning. The map is read-only for the server's lifetime.
  const bundledDroidLoad = await loadBundledDroids({
    systemVars: {
      design_catalog_dir: path.join(symphonyDataDir(), 'design-catalog'),
    },
  });
  if (bundledDroidLoad.warnings.length > 0) {
    for (const w of bundledDroidLoad.warnings) {
      console.error(`[symphony] bundled droid warning at ${w.source}: ${w.message}`);
    }
  }
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
      // Phase 4F.2 — see precedence rule in `SpawnWorkerDeps`.
      bundledDroids: bundledDroidLoad.droids,
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
  // Phase 5D — set_active_project MCP tool. Both this tool and the
  // `runtime.setActiveProject` RPC share `setDispatchActiveProject`
  // (top-level closure above) so audit + chat-row signal fire
  // identically regardless of which entry point flipped the cursor.
  registry.register(
    makeSetActiveProjectTool({
      projectStore,
      setDispatchActiveProject,
      persist: persistActiveProject,
    }),
  );
  registry.register(
    makeCreateWorktreeTool({ store: projectStore, worktreeManager }),
  );
  registry.register(
    makeListTasksTool({ taskStore, projectStore }),
  );
  registry.register(
    makeCreateTaskTool({
      taskStore,
      projectStore,
      // Phase 5D audit M1 fix — thread the cursor-aware resolver so
      // an omitted `project:` lands on the active project before
      // falling back to defaultProjectPath. Mirrors `spawn_worker`'s
      // optional-project shape; required because the v1 Maestro
      // prompt promises Maestro it can omit `project:` once a cursor
      // is set.
      resolveProjectPath,
    }),
  );
  registry.register(makeUpdateTaskTool({ taskStore }));
  registry.register(makeTaskNotesTool({ taskStore, projectStore }));
  // Phase 8D.1 — agent-native automation management (mirrors the
  // `symphony automations` CLI). Always registered: `automationStore` is
  // shared (SQLite/WAL), so a Maestro-created automation fires on the
  // Process-B scheduler's next tick. create_automation routes an omitted
  // `project:` through the active-project cursor (like create_task).
  registry.register(
    makeCreateAutomationTool({ automationStore, projectStore, resolveProjectPath }),
  );
  registry.register(makeListAutomationsTool({ automationStore }));
  registry.register(makeRemoveAutomationTool({ automationStore }));
  registry.register(makeSetAutomationEnabledTool({ automationStore }));
  registry.register(makeRunAutomationTool({ automationStore }));
  // Phase 8A — sync_notion is registered ONLY when a Notion connector is
  // active (configured + token present). Maestro's prompt instructs it to
  // call this only on an explicit "sync notion" request; absent the
  // connector the tool simply isn't on the surface.
  if (notionConnector !== undefined) {
    registry.register(
      makeSyncNotionTool({
        connector: notionConnector,
        taskStore,
        projectStore,
        externalLinkStore,
        resolveProjectPath,
      }),
    );
  }
  // Phase 8B — sync_obsidian + the live vault watcher are wired ONLY when an
  // Obsidian connector is active (configured vault). The watcher uses
  // `ignoreInitial` so it never bulk-imports on boot — `sync_obsidian` seeds,
  // the watcher tops up. It's started unless config `watch === false` or the
  // `obsidianWatch` test seam forces it off.
  if (obsidianConnector !== undefined) {
    registry.register(
      makeSyncObsidianTool({
        connector: obsidianConnector,
        taskStore,
        projectStore,
        externalLinkStore,
        resolveProjectPath,
      }),
    );
    // The watcher reads the on-disk config for the vault path; only run it on
    // the REAL boot path (`obsidian.enabled === true`). Injected-connector
    // tests never touch disk and exercise the watcher standalone.
    // `obsidianWatch === false` force-disables even on the real boot path.
    //
    // EXACTLY-ONE-WATCHER: under `symphony start` both the bootstrap RPC server
    // (Process B) AND Maestro's MCP child (Process C) construct the connector
    // (shared SQLite). The writeback hook is safe in both (a given update fires
    // in one process), but the watcher is a task SOURCE — two watchers on the
    // same vault would double-create. `--plugins` runs ONLY in Process C (the
    // documented PluginHost invariant), so the watcher runs in the non-plugin
    // server (bootstrap / standalone) only.
    if (
      options.obsidian?.enabled === true &&
      options.obsidianWatch !== false &&
      options.plugins?.enabled !== true
    ) {
      const obsidianConfig = await loadObsidianConfig().catch(() => undefined);
      if (obsidianConfig !== undefined && obsidianConfig.watch) {
        obsidianWatcher = new ObsidianVaultWatcher({
          connector: obsidianConnector,
          taskStore,
          projectStore,
          externalLinkStore,
          resolveProjectPath,
          vaultRoot: obsidianConfig.vaultPath,
          exclude: obsidianConfig.exclude,
          log: obsidianLog,
        });
        obsidianWatcher.start();
      }
    }
  }
  // Phase 8D.1 — automation scheduler. EXACTLY-ONE-SCHEDULER: like the
  // Obsidian watcher, it runs in the bootstrap Process B only (never
  // Maestro's `--plugins` child C) so a due automation is claimed once.
  // Reconcile orphaned runs from a prior session BEFORE the first tick
  // (emdash ordering — never tick before reconcile), then start.
  const automationLog = (level: 'info' | 'warn' | 'error', message: string): void => {
    const line = `[symphony] automations: ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    // info stays quiet — surfaced only on demand.
  };
  if (options.automationScheduler !== undefined) {
    automationScheduler = options.automationScheduler;
  } else if (
    options.automations?.enabled === true &&
    options.plugins?.enabled !== true &&
    bootAutomationsEnabled !== false
  ) {
    automationScheduler = new AutomationScheduler({
      store: automationStore,
      broker: automationsBroker,
      ...(options.automationTickIntervalMs !== undefined
        ? { tickIntervalMs: options.automationTickIntervalMs }
        : {}),
      log: automationLog,
    });
  }
  if (automationScheduler !== undefined) {
    const scheduler = automationScheduler;
    void scheduler
      .reconcile('startup')
      .catch(() => {})
      .finally(() => scheduler.start());
  }
  // Phase 8D.2 — automation trigger engine. Same EXACTLY-ONE gating as the
  // scheduler (Process B only, automations enabled). Built from whichever 8C
  // connectors are active; if none are configured the source map is empty and
  // the engine simply polls nothing. Started right after the scheduler.
  if (options.automationTriggerEngine !== undefined) {
    automationTriggerEngine = options.automationTriggerEngine;
  } else if (
    options.automations?.enabled === true &&
    options.plugins?.enabled !== true &&
    bootAutomationsEnabled !== false
  ) {
    const triggerSources: ReadonlyMap<string, TriggerSource> =
      options.automationTriggerSources ??
      (() => {
        const sources = new Map<string, TriggerSource>();
        const add = (
          connector: IssueConnectorHandle | undefined,
          triggerType: string,
          displayType: string,
          log: (level: 'info' | 'warn' | 'error', message: string) => void,
        ): void => {
          if (connector !== undefined) {
            sources.set(
              triggerType,
              makeIssueTriggerSource({ connector, triggerType, displayType, log }),
            );
          }
        };
        add(linearConnector, 'linear_issue', 'Linear issue', linearLog);
        add(githubConnector, 'github_issue', 'GitHub issue', githubLog);
        add(jiraConnector, 'jira_issue', 'Jira issue', jiraLog);
        add(gitlabConnector, 'gitlab_issue', 'GitLab issue', gitlabLog);
        add(plainConnector, 'plain_thread', 'Plain thread', plainLog);
        add(forgejoConnector, 'forgejo_issue', 'Forgejo issue', forgejoLog);
        return sources;
      })();
    automationTriggerEngine = new AutomationTriggerEngine({
      store: automationStore,
      sources: triggerSources,
      broker: automationsBroker,
      ...(options.automationTriggerPollIntervalMs !== undefined
        ? { pollIntervalMs: options.automationTriggerPollIntervalMs }
        : {}),
      ...(options.automationTriggerWarmupMs !== undefined
        ? { warmupMs: options.automationTriggerWarmupMs }
        : {}),
      log: automationLog,
    });
  }
  if (automationTriggerEngine !== undefined) {
    automationTriggerEngine.start();
  }
  // Phase 8C — sync_linear is registered ONLY when a Linear connector is active
  // (API key present). Maestro's prompt calls it on an explicit "sync linear"
  // request; absent the connector the tool simply isn't on the surface.
  if (linearConnector !== undefined) {
    registry.register(
      makeSyncIssuesTool({
        connector: linearConnector,
        name: 'sync_linear',
        description:
          'Pull open issues from Linear into Symphony. Creates one pending task per new issue (idempotent — already-imported issues are skipped). Routes by Linear project/team, skips issues already in a completed/canceled state. On task completion Symphony moves the Linear issue to a completed workflow state. Requires `symphony config linear`.',
        taskStore,
        projectStore,
        externalLinkStore,
        resolveProjectPath,
      }),
    );
  }
  // Phase 8C.2 — sync_github is registered ONLY when a GitHub connector is active
  // (token + at least one repo). Same on-demand surface as sync_linear.
  if (githubConnector !== undefined) {
    registry.register(
      makeSyncIssuesTool({
        connector: githubConnector,
        name: 'sync_github',
        description:
          'Pull open issues from the configured GitHub repos into Symphony. Creates one pending task per new issue (idempotent — already-imported issues are skipped), excludes pull requests, and routes by `owner/repo`. On task completion Symphony comments on and closes the GitHub issue. Requires `symphony config github`.',
        taskStore,
        projectStore,
        externalLinkStore,
        resolveProjectPath,
      }),
    );
  }
  // Phase 8C.3 — sync_jira is registered ONLY when a Jira connector is active
  // (token + site URL + email). Same on-demand surface as sync_linear.
  if (jiraConnector !== undefined) {
    registry.register(
      makeSyncIssuesTool({
        connector: jiraConnector,
        name: 'sync_jira',
        description:
          'Pull open issues from Jira into Symphony. Creates one pending task per new issue (idempotent — already-imported issues are skipped), skips issues already in a Done-category status, and routes by Jira project key. Uses a permission-aware JQL fallback (assigned/reported issues when a token cannot browse all projects). On task completion Symphony comments on and transitions the Jira issue to a Done state. Requires `symphony config jira`.',
        taskStore,
        projectStore,
        externalLinkStore,
        resolveProjectPath,
      }),
    );
  }
  // Phase 8C.3 — sync_gitlab is registered ONLY when a GitLab connector is active
  // (token + at least one project). Same on-demand surface as sync_linear.
  if (gitlabConnector !== undefined) {
    registry.register(
      makeSyncIssuesTool({
        connector: gitlabConnector,
        name: 'sync_gitlab',
        description:
          'Pull open issues from the configured GitLab projects into Symphony. Creates one pending task per new issue (idempotent — already-imported issues are skipped) and routes by `group/project`. On task completion Symphony adds a note and closes the GitLab issue. Requires `symphony config gitlab`.',
        taskStore,
        projectStore,
        externalLinkStore,
        resolveProjectPath,
      }),
    );
  }
  // Phase 8C.4 — sync_plain is registered ONLY when a Plain connector is active
  // (token present). Same on-demand surface as sync_linear.
  if (plainConnector !== undefined) {
    registry.register(
      makeSyncIssuesTool({
        connector: plainConnector,
        name: 'sync_plain',
        description:
          'Pull open support threads from Plain into Symphony. Creates one pending task per new thread (idempotent — already-imported threads are skipped) and skips threads already marked Done. Plain has no project concept, so pass `project:` (or rely on the active project) to route. On task completion Symphony posts an internal note and marks the Plain thread Done. Requires `symphony config plain`.',
        taskStore,
        projectStore,
        externalLinkStore,
        resolveProjectPath,
      }),
    );
  }
  // Phase 8C.4 — sync_forgejo is registered ONLY when a Forgejo connector is
  // active (token + site URL + at least one repo). Same on-demand surface as
  // sync_github.
  if (forgejoConnector !== undefined) {
    registry.register(
      makeSyncIssuesTool({
        connector: forgejoConnector,
        name: 'sync_forgejo',
        description:
          'Pull open issues from the configured Forgejo repos into Symphony. Creates one pending task per new issue (idempotent — already-imported issues are skipped) and routes by `owner/repo`. On task completion Symphony comments on and closes the Forgejo issue. Requires `symphony config forgejo`.',
        taskStore,
        projectStore,
        externalLinkStore,
        resolveProjectPath,
      }),
    );
  }
  // Phase 5E — cross-project sagas. `create_saga` writes both the saga
  // row AND the member tasks atomically; downstream `spawn_worker
  // (task_id=...)` claims members per the existing 3P pattern. The
  // rollup listener (wired on `taskStore.onTaskStatusChange` above)
  // keeps the saga row in sync with member transitions.
  registry.register(
    makeCreateSagaTool({ sagaStore, taskStore, projectStore }),
  );
  registry.register(makeUpdateSagaTool({ sagaStore }));
  registry.register(makeListSagasTool({ sagaStore, projectStore }));
  registry.register(makeGetSagaTool({ sagaStore }));

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
  // Phase 4G.2 — UI verification leg. Boots `previewCommand`, captures
  // desktop + mobile screenshots via programmatic Playwright, writes
  // them to `<worktree>/.symphony/screenshots/<iso>/`. Maestro spawns a
  // fresh reviewer worker against the screenshots; reviewer reads them
  // via Claude Code's `Read` tool.
  registry.register(
    makeVerifyUiTool({
      registry: workerRegistry,
      projectStore,
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
      // Phase 5E — saga store powers the saga-partial gate. Finalize
      // refuses to merge a saga slice when siblings are incomplete
      // unless `force_saga_partial:true` (tier 3).
      sagaStore,
    }),
  );

  // Phase 7A — plugin host. Activated only when this is Maestro's MCP
  // child (`options.plugins.enabled`, set via `--plugins`) AND the user's
  // `pluginsEnabled` master switch is on AND a persistent DB exists (the
  // plugin registry lives in SQLite). The bootstrap RPC server never sets
  // `options.plugins.enabled`, so plugin subprocesses are not double-
  // spawned. A plugin failure is isolated inside the host — boot proceeds.
  let pluginHost: PluginHost | undefined;
  if (
    options.plugins?.enabled === true &&
    bootPluginsEnabled === true &&
    options.database !== undefined
  ) {
    const host = new PluginHost({
      store: new SqlitePluginStore(options.database.db),
      registry,
    });
    try {
      await host.start();
      pluginHost = host;
      pluginHostRef.current = host;
    } catch (err) {
      // Defensive — `start()` already isolates per-plugin failures, so a
      // throw here is unexpected (e.g. the store query). Never block boot.
      console.error(
        `[symphony] plugin host failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const transport = options.transport ?? new StdioServerTransport();
  await server.connect(transport);

  const rpcConfig = options.rpc ?? {};
  // Default OFF — library callers must opt in. The `symphony mcp-server`
  // CLI command sets `{ enabled: true }` explicitly.
  const rpcEnabled = rpcConfig.enabled === true;
  let rpcHandle: (RpcServerHandle & { token: string; tokenFilePath?: string }) | undefined;
  if (rpcEnabled) {
    const token = rpcConfig.token ?? generateRpcToken();
    // Phase 7C — Plugins panel RPC surface. The plugin registry lives in
    // SQLite (shared with Maestro's plugin host via WAL), so wire the admin
    // whenever a persistent DB exists — independent of `options.plugins`
    // (the bootstrap RPC server never sets `plugins.enabled`, but it owns
    // the human-driven RPC view the TUI talks to). Reads + mutations land
    // on the shared registry; the host picks up `enabled`/install changes
    // on its next start.
    const pluginAdmin =
      options.database !== undefined
        ? createPluginAdmin({ store: new SqlitePluginStore(options.database.db) })
        : undefined;
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
        const prev = context.awayMode;
        context = { ...context, awayMode: value };
        if (prev !== value) {
          auditLogger.append({
            ts: new Date().toISOString(),
            kind: 'away_mode_changed',
            severity: 'info',
            headline: `away mode ${value ? 'enabled' : 'disabled'}`,
            payload: { from: prev, to: value },
          }, { rawKeys: ['from', 'to'] });
        }
      },
      // Phase 3S — same shape as setDispatchAwayMode but for the tier
      // cursor. The closure ALSO clears the capability evaluator's
      // first-use seen-set so notices re-arm: changing the tier is an
      // implicit re-confirmation of intent, and a stale tier-2 session
      // shouldn't silently suppress notices after the user dialed up to
      // tier-3-then-back. Symphony 6-site rule reference impl.
      setDispatchAutonomyTier: (value) => {
        const prev = context.tier;
        context = { ...context, tier: value };
        capabilityEvaluator.resetFirstUseTracker();
        if (prev !== value) {
          auditLogger.append({
            ts: new Date().toISOString(),
            kind: 'tier_changed',
            severity: 'info',
            headline: `autonomy tier ${prev} → ${value}`,
            payload: { from: prev, to: value },
          }, { rawKeys: ['from', 'to'] });
        }
      },
      // Phase 5D — see the top-level `setDispatchActiveProject`
      // closure. Audit + chat-row signal fire from there so the MCP
      // tool path and the RPC path both flow through one writer.
      setDispatchActiveProject,
      // Phase 3T — bridge the runtime.interrupt RPC's pivot-pending flag
      // into the live dispatch context. The shim reads
      // `ctx.interruptPending` and short-circuits ACT-scope tool calls
      // while it's true (Maestro's still-streaming turn cannot spawn
      // fresh workers between the RPC firing and `turn_completed`).
      // Cleared via the TUI's explicit `runtime.clearInterruptPending`
      // RPC after `MaestroDataController.sendUserMessage` wraps + sends
      // the user's next message with the [INTERRUPT NOTICE] envelope.
      // Cross-process limitation documented in dispatch.ts + types.ts.
      setInterruptPending: (value) => {
        context = { ...context, interruptPending: value };
      },
      // Phase 8D.1 — the launcher flips this while delivering an
      // automation-fired turn so the capability evaluator denies
      // `requires-host-browser-control` tools (capabilities.ts:54).
      // Same cross-process limitation as setInterruptPending: flips
      // only on THIS server's cursor; Maestro's MCP child is separate.
      automationStore,
      setDispatchAutomationContext: (value) => {
        context = { ...context, automationContext: value };
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
      // Phase 3R — read-only audit surface for the `/log` popup.
      auditStore,
      // Phase 7C — Plugins panel surface (list / enable-disable / install /
      // remove). Undefined in no-DB mode → `plugins.list` returns [] and
      // the mutators throw a typed bad_args.
      ...(pluginAdmin !== undefined ? { pluginAdmin } : {}),
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
      // Phase 8D.1 — accept `subscribe('automations.events')` (wake hints).
      automationsBroker,
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
    // Phase 8D.1/8D.2 — stop the scheduler + trigger engine FIRST (both are
    // task sources — quiesce them before stores/broker tear down so no tick or
    // poll claims a run mid-shutdown).
    if (automationScheduler !== undefined) {
      await automationScheduler.stop().catch(() => {});
    }
    if (automationTriggerEngine !== undefined) {
      await automationTriggerEngine.stop().catch(() => {});
    }
    // Phase 8B — stop the vault watcher next so no late fs event ingests a
    // task into stores that are about to tear down. Independent + best-effort.
    if (obsidianWatcher !== undefined) {
      await obsidianWatcher.stop().catch(() => {});
    }
    // Phase 7A — close plugin subprocesses FIRST so their stdio teardown
    // doesn't race the registry/server close. Isolated + best-effort.
    if (pluginHost !== undefined) {
      pluginHostRef.current = undefined;
      await pluginHost.shutdown().catch(() => {});
    }
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
      automationsBroker.clear();
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
    // Phase 3R — drain auditLogger LAST so teardown errors from the
    // dispatchers above land in the audit log. Sets the disposed flag
    // + awaits file-sink flush.
    await auditLogger.shutdown().catch(() => {});
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
    externalLinkStore,
    ...(notionConnector !== undefined ? { notionConnector } : {}),
    ...(obsidianConnector !== undefined ? { obsidianConnector } : {}),
    ...(linearConnector !== undefined ? { linearConnector } : {}),
    ...(githubConnector !== undefined ? { githubConnector } : {}),
    ...(jiraConnector !== undefined ? { jiraConnector } : {}),
    ...(gitlabConnector !== undefined ? { gitlabConnector } : {}),
    ...(plainConnector !== undefined ? { plainConnector } : {}),
    ...(forgejoConnector !== undefined ? { forgejoConnector } : {}),
    sagaStore,
    questionStore,
    waveStore,
    notificationDispatcher,
    completionsBroker,
    completionSummarizer,
    autoMergeBroker,
    autoMergeDispatcher,
    taskReadyBroker,
    taskReadyDispatcher,
    automationStore,
    automationsBroker,
    ...(automationScheduler !== undefined ? { automationScheduler } : {}),
    ...(automationTriggerEngine !== undefined ? { automationTriggerEngine } : {}),
    auditLogger,
    auditStore,
    ...(pluginHost !== undefined ? { pluginHost } : {}),
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

// ===== Phase 3R audit helpers =====

const WORKER_STATUS_TO_AUDIT: Partial<Record<WorkerStatus, AuditKind>> = {
  completed: 'worker_completed',
  failed: 'worker_failed',
  crashed: 'worker_crashed',
  timeout: 'worker_timeout',
  killed: 'worker_killed',
  interrupted: 'worker_interrupted',
};

const WORKER_STATUS_SEVERITY: Partial<Record<WorkerStatus, AuditSeverity>> = {
  completed: 'info',
  failed: 'error',
  crashed: 'error',
  timeout: 'warn',
  killed: 'info',
  interrupted: 'info',
};

function auditWorkerExit(logger: AuditLogger, record: WorkerRecord): void {
  const kind = WORKER_STATUS_TO_AUDIT[record.status];
  if (kind === undefined) return; // not a terminal status we audit
  const severity = WORKER_STATUS_SEVERITY[record.status] ?? 'info';
  const intent = record.featureIntent || record.taskDescription || record.id;
  const verb = kind.replace('worker_', '');
  logger.append(
    {
      ts: new Date().toISOString(),
      kind,
      severity,
      projectId: record.projectId,
      workerId: record.id,
      taskId: record.taskId ?? null,
      headline: `${verb}: ${intent}`,
      payload: {
        role: record.role,
        status: record.status,
        ...(record.exitInfo?.exitCode != null ? { exitCode: record.exitInfo.exitCode } : {}),
        ...(record.exitInfo?.signal != null ? { exitSignal: record.exitInfo.signal } : {}),
        ...(record.costUsd !== undefined ? { costUsd: record.costUsd } : {}),
      },
    },
    { rawKeys: ['role', 'status', 'exitCode', 'exitSignal', 'costUsd'] },
  );
}

function auditQuestionAsked(logger: AuditLogger, record: QuestionRecord): void {
  logger.append({
    ts: new Date().toISOString(),
    kind: 'question_asked',
    severity: 'info',
    projectId: record.projectId ?? null,
    workerId: record.workerId ?? null,
    headline: `question asked: ${record.question.slice(0, 80)}`,
    payload: {
      urgency: record.urgency,
      // question text is sanitized by AuditLogger.append by default
      question: record.question,
    },
  }, { rawKeys: ['urgency'] });
}

function auditQuestionAnswered(logger: AuditLogger, record: QuestionRecord): void {
  logger.append({
    ts: new Date().toISOString(),
    kind: 'question_answered',
    severity: 'info',
    projectId: record.projectId ?? null,
    workerId: record.workerId ?? null,
    headline: `question answered: ${record.question.slice(0, 80)}`,
    // answer + question both sanitized; answers can carry copy-pasted secrets
    payload: {
      urgency: record.urgency,
      question: record.question,
      answer: record.answer ?? '',
    },
  }, { rawKeys: ['urgency'] });
}

// Audit M3: `asked` is NOT audited here. It's the question-enqueued
// precursor of an `ask`-mode merge; `questionStore.onQuestionEnqueued`
// already writes a `question_asked` row for the exact same user-facing
// event. Aliasing `asked → merge_ready` double-logged AND was
// semantically wrong (`merge_ready` is the `never`-mode "branch left
// for manual review" state). Map only the four real merge outcomes.
const AUTOMERGE_KIND_TO_AUDIT: Partial<Record<AutoMergeEvent['kind'], AuditKind>> = {
  merged: 'merge_performed',
  declined: 'merge_declined',
  failed: 'merge_failed',
  ready: 'merge_ready',
};

const AUTOMERGE_KIND_SEVERITY: Partial<Record<AutoMergeEvent['kind'], AuditSeverity>> = {
  merged: 'info',
  declined: 'info',
  failed: 'error',
  ready: 'info',
};

function auditAutoMergeEvent(logger: AuditLogger, event: AutoMergeEvent): void {
  const kind = AUTOMERGE_KIND_TO_AUDIT[event.kind];
  if (kind === undefined) return; // 'asked' — covered by question_asked
  logger.append(
    {
      ts: event.ts,
      kind,
      severity: AUTOMERGE_KIND_SEVERITY[event.kind] ?? 'info',
      workerId: event.workerId,
      headline: event.headline,
      payload: {
        branch: event.branch,
        projectName: event.projectName,
        mergeTo: event.mergeTo,
        ...(event.mergeSha !== undefined ? { mergeSha: event.mergeSha } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        ...(event.cleanupWarning !== undefined ? { cleanupWarning: event.cleanupWarning } : {}),
      },
    },
    { rawKeys: ['branch', 'projectName', 'mergeTo', 'mergeSha'] },
  );
}

/**
 * Phase 3R — minimal in-memory AuditStore for tests / no-database mode.
 * Implements the same shape as `SqliteAuditStore` so the AuditLogger and
 * RPC layer don't branch on the backing store.
 */
function createMemoryAuditStore(): AuditStore {
  const rows: AuditEntry[] = [];
  let nextId = 1;
  return {
    append(input: AuditAppendInput) {
      const entry: AuditEntry = {
        id: nextId++,
        ts: input.ts,
        kind: input.kind,
        severity: input.severity ?? 'info',
        projectId: input.projectId ?? null,
        workerId: input.workerId ?? null,
        taskId: input.taskId ?? null,
        toolName: input.toolName ?? null,
        headline: input.headline,
        payload: Object.freeze({ ...(input.payload ?? {}) }),
      };
      rows.push(entry);
      if (rows.length > 10_000) rows.shift();
      return entry;
    },
    list(filter = {}) {
      let out = [...rows].reverse();
      if (filter.projectId !== undefined) {
        out = out.filter((r) => r.projectId === filter.projectId);
      }
      if (filter.severity !== undefined) {
        out = out.filter((r) => r.severity === filter.severity);
      }
      if (filter.workerId !== undefined) {
        out = out.filter((r) => r.workerId === filter.workerId);
      }
      if (filter.kinds !== undefined && filter.kinds.length > 0) {
        const set = new Set<AuditKind>(filter.kinds);
        out = out.filter((r) => set.has(r.kind));
      }
      if (filter.sinceTs !== undefined) {
        out = out.filter((r) => r.ts >= filter.sinceTs!);
      }
      if (filter.untilTs !== undefined) {
        out = out.filter((r) => r.ts <= filter.untilTs!);
      }
      // Audit M4 — identical clamp semantics to SqliteAuditStore so the
      // test/no-db oracle never diverges (negative/non-finite limit must
      // NOT slice(0,-N); offset coerced the same way).
      const limit = clampAuditLimit(filter.limit);
      const offset = clampAuditOffset(filter.offset);
      return out.slice(offset, offset + limit);
    },
    count(filter = {}) {
      return this.list({ ...filter, limit: 1_000_000, offset: 0 }).length;
    },
  };
}

/**
 * Phase 5A — merge `<projectPath>/.symphony.json` `project` section overlay
 * with the caller-supplied `options.projectConfigs` overlay. Caller wins.
 *
 * Precedence (lowest → highest):
 *   1. SQL NULL defaults
 *   2. `.symphony.json` `project` section (file overlay)
 *   3. `options.projectConfigs[name]` (caller overlay)
 *
 * Warnings from each loader are forwarded to `console.warn` — a broken
 * `.symphony.json` must NOT crash orchestrator boot. Logs the project
 * name + the loader's diagnostic so the user can act.
 *
 * Returns a new map; never mutates either input. Empty file overlay +
 * empty caller overlay yields an empty entry (downstream paths spread
 * an empty object cleanly).
 */
export function mergeProjectConfigsWithFiles(
  projects: Readonly<Record<string, string>>,
  callerConfigs?: Readonly<Record<string, ProjectConfigInput>>,
): Record<string, ProjectConfigInput> {
  const merged: Record<string, ProjectConfigInput> = {};
  for (const [name, pathStr] of Object.entries(projects)) {
    if (!pathStr || typeof pathStr !== 'string') continue;
    const resolved = path.resolve(pathStr);
    const fileResult = readProjectConfig(resolved);
    for (const w of fileResult.warnings) {
      console.warn(`[symphony] project '${name}': ${w}`);
    }
    const fileOverlay = fileResult.overlay ?? {};
    const callerOverlay = callerConfigs?.[name] ?? {};
    merged[name] = { ...fileOverlay, ...callerOverlay };
  }
  // Audit M1 fix: preserve caller-only entries (no `projects` map
  // counterpart) — file overlay is unreachable in that case but the
  // caller's config must still flow through. Phase 5B's CLI-registration
  // path will exercise this when `symphony add` registers a project
  // BEFORE the orchestrator-boot map is rebuilt.
  if (callerConfigs !== undefined) {
    for (const [name, cfg] of Object.entries(callerConfigs)) {
      if (name in merged) continue;
      merged[name] = { ...cfg };
    }
  }
  return merged;
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
  // Phase 5A audit-C1 fix: the primary CLI boot path
  // (`cd ~/myapp && symphony start`) hits THIS function without ever
  // going through `mergeProjectConfigsWithFiles` (the `projects` map is
  // empty when no `--project` flag is passed). Read the file overlay
  // here so `<defaultPath>/.symphony.json` is honored. Caller overlay
  // (synthesized `default` entry if the user passed one) still wins.
  const fileResult = readProjectConfig(defaultPath);
  for (const w of fileResult.warnings) {
    console.warn(`[symphony] default project: ${w}`);
  }
  const fileOverlay = fileResult.overlay ?? {};
  const callerOverlay = projectConfigs?.[name] ?? projectConfigs?.['default'] ?? {};
  store.register({
    id: name,
    name,
    path: defaultPath,
    createdAt: '',
    ...fileOverlay,
    ...callerOverlay,
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
