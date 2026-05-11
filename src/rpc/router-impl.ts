import path from 'node:path';
import type { ProjectStore, ProjectSnapshot } from '../projects/types.js';
import type {
  CreateTaskInput,
  TaskPatch,
  TaskSnapshot,
  TaskStore,
  TaskListFilter,
} from '../state/types.js';
import type { QuestionStore, QuestionSnapshot } from '../state/question-registry.js';
import type { WaveStore, WaveSnapshot } from '../orchestrator/research-wave-registry.js';
import type { ModeController } from '../orchestrator/mode.js';
import {
  TERMINAL_WORKER_STATUSES,
  mergeLiveAndPersisted,
  type WorkerRecordSnapshot,
  type WorkerRegistry,
} from '../orchestrator/worker-registry.js';
import type { StreamEvent } from '../workers/types.js';
import type { ToolMode, AutonomyTier } from '../orchestrator/types.js';
import { createRPCController, createRPCRouter } from './router.js';
import { applyPatchToDisk, loadConfig } from '../utils/config.js';
import type { DispatcherHandle } from '../notifications/types.js';
import type {
  PendingSpawnSnapshot,
  WorkerLifecycleHandle,
} from '../orchestrator/worker-lifecycle.js';
import {
  GitOpsError,
  currentBranch,
  diffWorktree,
  mergeBase,
  refExists,
} from '../orchestrator/git-ops.js';
import { getCurrentSignal } from './dispatcher.js';

/**
 * Symphony WS-RPC router definition — Phase 2B.2.
 *
 * Wraps each `Store` interface with namespace-keyed procedures the TUI
 * (Phase 3) and future clients call. Every handler is a thin pass-through
 * — no business logic in the router. The `IpcClient<RpcRouter>` mapped
 * type derives the client surface from this file.
 *
 * Procedures return only `Snapshot` shapes (immutable, plain-JSON
 * serializable). Callers must NEVER receive a live `WorkerRecord` (carries
 * a `Worker` handle that doesn't traverse the wire).
 *
 * Maestro-only operations (`spawn_worker`, `finalize`, `audit_changes`,
 * `research_wave`, `propose_plan`, `review_diff`, `think`, `ask_user`,
 * `find_worker`, `global_status`, `create_worktree`, `resume_worker`,
 * `send_to_worker`) are deliberately ABSENT — those ship over MCP-stdio
 * to Maestro. The RPC surface is the human-driven view.
 */

export interface RouterDeps {
  readonly projectStore: ProjectStore;
  readonly taskStore: TaskStore;
  readonly questionStore: QuestionStore;
  readonly waveStore: WaveStore;
  readonly workerRegistry: WorkerRegistry;
  readonly modeController: ModeController;
  /**
   * Phase 3H.3 — optional. When omitted, the `notifications.flushAwayDigest`
   * RPC procedure resolves a no-op. The CLI server wires the real
   * dispatcher in `server.ts`; older test rigs that don't care about
   * notifications can leave it out.
   */
  readonly notificationDispatcher?: DispatcherHandle;
  /**
   * Phase 3L — optional. When omitted, the `queue.list`/`queue.cancel`/
   * `queue.reorder` RPC procedures resolve `not_found` so legacy test
   * rigs that don't construct a real lifecycle keep working. CLI server
   * wires the lifecycle in `server.ts`.
   */
  readonly workerLifecycle?: Pick<
    WorkerLifecycleHandle,
    'listPendingGlobal' | 'cancelQueued' | 'reorderQueued'
  >;
  /**
   * Phase 3M — optional. When omitted, the `runtime.setAwayMode` RPC
   * procedure resolves to a no-op (still validates args). The CLI server
   * wires a closure that mutates the in-process dispatch-context cursor;
   * legacy test rigs that don't construct a context can leave it out.
   */
  readonly setDispatchAwayMode?: (awayMode: boolean) => void;
}

// ── Argument shapes (validated at the boundary) ──────────────────────

export interface ProjectsListArgs {
  readonly nameContains?: string;
}

export interface ProjectsRegisterArgs {
  readonly name: string;
  readonly path: string;
  readonly gitRemote?: string;
  readonly gitBranch?: string;
  readonly baseRef?: string;
  readonly defaultModel?: string;
}

export interface TasksListArgs {
  readonly projectId?: string;
  readonly status?: TaskListFilter['status'];
}

export interface TasksUpdateArgs {
  readonly id: string;
  readonly patch: TaskPatch;
}

export interface WorkersListArgs {
  readonly projectPath?: string;
  readonly status?: WorkerRecordSnapshot['status'] | readonly WorkerRecordSnapshot['status'][];
  readonly includeTerminal?: boolean;
}

export interface WorkersKillArgs {
  readonly workerId: string;
  readonly reason?: string;
}

export interface WorkersTailArgs {
  readonly workerId: string;
  readonly n?: number;
}

export interface WorkersTailResult {
  readonly events: readonly StreamEvent[];
  readonly total: number;
}

export interface WorkersDiffArgs {
  readonly workerId: string;
  readonly capBytes?: number;
}

export interface WorkersDiffFile {
  readonly path: string;
  readonly status: string;
}

export interface WorkersDiffResult {
  readonly resolvedBase: string;
  readonly mergeBaseSha: string;
  readonly branch: string | null;
  readonly diff: string;
  readonly bytes: number;
  readonly truncated: boolean;
  /**
   * The cap (in bytes) applied to the diff body when `truncated === true`,
   * else `null`. Phase 3J audit M3: the TUI must display the byte cap that
   * was actually enforced, not the JS string length of the truncated body
   * (which mixes UTF-16 code units with the appended trailer line).
   */
  readonly cappedAt: number | null;
  readonly files: readonly WorkersDiffFile[];
}

export interface QuestionsListArgs {
  readonly answered?: boolean;
  readonly projectId?: string;
}

export interface QuestionsAnswerArgs {
  readonly id: string;
  readonly answer: string;
}

export interface ModeSnapshot {
  readonly mode: ToolMode;
}

export interface ModeSetModelArgs {
  readonly modelMode: 'opus' | 'mixed';
}

export interface ModeSetModelResult {
  readonly modelMode: 'opus' | 'mixed';
  /**
   * Phase 3H.2 audit M3 — warnings emitted by `loadConfig` when the
   * existing on-disk file was malformed (parse error, salvaged field).
   * The TUI surfaces these to the toast tray so a flip-via-RPC can't
   * silently destroy the user's hand-edited content.
   */
  readonly warnings: readonly string[];
}

// ── Runtime argument shapes (Phase 3M) ───────────────────────────────

export interface RuntimeSetAwayModeArgs {
  readonly awayMode: boolean;
}

export interface RuntimeSetAwayModeResult {
  readonly awayMode: boolean;
}

// ── Queue argument shapes (Phase 3L) ─────────────────────────────────

export interface QueueCancelArgs {
  readonly recordId: string;
}

export interface QueueCancelResult {
  readonly cancelled: boolean;
  readonly reason?: string;
}

export interface QueueReorderArgs {
  readonly recordId: string;
  readonly direction: 'up' | 'down';
}

export interface QueueReorderResult {
  readonly moved: boolean;
  readonly reason?: string;
}

// Re-export so client SDKs can type the wire shape without reaching
// into orchestrator/worker-lifecycle.js.
export type { PendingSpawnSnapshot };

// ── Router builder ────────────────────────────────────────────────────

export function createSymphonyRouter(deps: RouterDeps) {
  const { projectStore, taskStore, questionStore, waveStore, workerRegistry, modeController } =
    deps;

  const projects = createRPCController({
    list(args?: ProjectsListArgs): ProjectSnapshot[] {
      return projectStore.snapshots(args ?? {});
    },
    get(nameOrId: string): ProjectSnapshot | null {
      requireString(nameOrId, 'nameOrId');
      return projectStore.snapshot(nameOrId) ?? null;
    },
    register(args: ProjectsRegisterArgs): ProjectSnapshot {
      requireString(args?.name, 'name');
      requireString(args?.path, 'path');
      const resolved = path.resolve(args.path);
      const existingByName = projectStore.get(args.name);
      if (existingByName !== undefined) {
        throw badArgs(`project name '${args.name}' is already registered`);
      }
      const existingByPath = projectStore
        .list()
        .find((r) => path.resolve(r.path) === resolved);
      if (existingByPath !== undefined) {
        throw badArgs(`project path '${resolved}' is already registered as '${existingByPath.name}'`);
      }
      const record = projectStore.register({
        id: args.name,
        name: args.name,
        path: args.path,
        createdAt: '',
        ...(args.gitRemote !== undefined ? { gitRemote: args.gitRemote } : {}),
        ...(args.gitBranch !== undefined ? { gitBranch: args.gitBranch } : {}),
        ...(args.baseRef !== undefined ? { baseRef: args.baseRef } : {}),
        ...(args.defaultModel !== undefined ? { defaultModel: args.defaultModel } : {}),
      });
      const snap = projectStore.snapshot(record.id);
      if (snap === undefined) {
        throw new Error(`projects.register: snapshot missing for '${record.id}' after insert`);
      }
      return snap;
    },
  });

  const tasks = createRPCController({
    list(args?: TasksListArgs): TaskSnapshot[] {
      return taskStore.snapshots(coerceTaskFilter(args));
    },
    get(id: string): TaskSnapshot | null {
      requireString(id, 'id');
      return taskStore.snapshot(id) ?? null;
    },
    create(input: CreateTaskInput): TaskSnapshot {
      requireString(input?.projectId, 'projectId');
      requireBoundedString(input?.description, 'description', TASKS_DESCRIPTION_MAX);
      // Resolve project name → id so the task references a stable id even
      // if Phase 2B swaps in UUID-keyed records (audit M2 from 2A.4a).
      const project = projectStore.get(input.projectId);
      if (project === undefined) {
        throw badArgs(`project '${input.projectId}' is not registered`);
      }
      const record = taskStore.create({
        projectId: project.id,
        description: input.description,
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.dependsOn !== undefined ? { dependsOn: input.dependsOn } : {}),
      });
      const snap = taskStore.snapshot(record.id);
      if (snap === undefined) {
        throw new Error(`tasks.create: snapshot missing for '${record.id}' after insert`);
      }
      return snap;
    },
    update(args: TasksUpdateArgs): TaskSnapshot {
      requireString(args?.id, 'id');
      // Phase 2B.2 m7 — only `notes` is a long-form field on the patch;
      // `status`/`workerId`/`result` are short. Cap notes; let the rest
      // pass through to the store's own validation.
      if (args?.patch?.notes !== undefined) {
        requireBoundedString(args.patch.notes, 'patch.notes', TASKS_NOTES_MAX);
      }
      const record = taskStore.update(args.id, args.patch ?? {});
      const snap = taskStore.snapshot(record.id);
      if (snap === undefined) {
        throw new Error(`tasks.update: snapshot missing for '${record.id}' after update`);
      }
      return snap;
    },
  });

  const workers = createRPCController({
    list(args?: WorkersListArgs): WorkerRecordSnapshot[] {
      const includeTerminal = args?.includeTerminal ?? true;
      const filterByPath = args?.projectPath;
      const merged = mergeLiveAndPersisted(workerRegistry, {
        projectStore,
        includeTerminal,
        ...(filterByPath !== undefined ? { projectPath: filterByPath } : {}),
      });
      const status = args?.status;
      if (status === undefined) return merged;
      const allowed = new Set(Array.isArray(status) ? status : [status]);
      return merged.filter((s) => allowed.has(s.status));
    },
    get(workerId: string): WorkerRecordSnapshot | null {
      requireString(workerId, 'workerId');
      return workerRegistry.snapshot(workerId) ?? null;
    },
    kill(args: WorkersKillArgs): { killed: boolean; reason?: string } {
      requireString(args?.workerId, 'workerId');
      const record = workerRegistry.get(args.workerId);
      if (record === undefined) {
        throw notFound(`worker '${args.workerId}' is not registered`);
      }
      // Audit m9: a recovered/crashed worker has a stub `Worker` whose
      // `kill()` is a no-op. Returning `{killed: true}` would mislead the
      // user. Report the terminal status instead so the TUI can render
      // accurate state.
      if (TERMINAL_WORKER_STATUSES.has(record.status)) {
        return { killed: false, reason: `already terminal: ${record.status}` };
      }
      try {
        record.worker.kill();
        return { killed: true };
      } catch (cause) {
        throw new Error(
          `workers.kill: failed to kill '${args.workerId}': ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    },
    /**
     * Phase 3D.1 — return the tail of a worker's stream-event buffer for
     * output-panel backfill. Same source as the `get_worker_output` MCP
     * tool (`src/orchestrator/tools/get-worker-output.ts:69-71`); the
     * RPC method is the TUI-side equivalent so the output panel doesn't
     * need an MCP roundtrip.
     *
     * `n` defaults to 200 (PLAN.md decision — bounded snapshot, fits the
     * panel's render budget). Hard cap 500 matches `get_worker_output`'s
     * own ceiling for parity.
     */
    tail(args: WorkersTailArgs): WorkersTailResult {
      requireString(args?.workerId, 'workerId');
      const n = args?.n ?? 200;
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        throw badArgs('n must be an integer between 1 and 500');
      }
      const record = workerRegistry.get(args.workerId);
      if (record === undefined) {
        throw notFound(`worker '${args.workerId}' is not registered`);
      }
      const events = record.buffer.tail(n);
      return { events, total: record.buffer.total() };
    },
    /**
     * Phase 3J — capture the worker's worktree diff against the project
     * base branch via merge-base. The TUI's diff view consumes this
     * directly (no MCP roundtrip; Maestro has its own `review_diff` tool).
     *
     * BaseRef resolution chain (first existing ref wins):
     *   1. project.baseRef (explicit config)
     *   2. project.gitBranch (typically the parent branch)
     *   3. 'master'
     *   4. 'main'
     *
     * If none resolve, throws bad_args — the worker's worktree has no
     * known parent reference. Workers spawned without a registered
     * project still get the 'master' / 'main' fallback.
     *
     * Cap: 256 KB default, 512 KB max (the WS frame budget is 1 MiB so
     * 512 KB leaves headroom for the JSON envelope around the body).
     */
    async diff(args: WorkersDiffArgs): Promise<WorkersDiffResult> {
      requireString(args?.workerId, 'workerId');
      const cap = args?.capBytes ?? WORKERS_DIFF_CAP_DEFAULT;
      if (
        !Number.isInteger(cap) ||
        cap < WORKERS_DIFF_CAP_MIN ||
        cap > WORKERS_DIFF_CAP_MAX
      ) {
        throw badArgs(
          `capBytes must be an integer in [${WORKERS_DIFF_CAP_MIN}, ${WORKERS_DIFF_CAP_MAX}]`,
        );
      }
      const record = workerRegistry.get(args.workerId);
      if (record === undefined) {
        throw notFound(`worker '${args.workerId}' is not registered`);
      }
      const project =
        record.projectId !== null ? projectStore.snapshot(record.projectId) : undefined;
      const candidates: readonly string[] = [
        ...(project?.baseRef !== undefined ? [project.baseRef] : []),
        ...(project?.gitBranch !== undefined ? [project.gitBranch] : []),
        'master',
        'main',
      ];
      // Phase 3J audit M2: thread the per-call AbortSignal through every
      // `git` invocation. `refExists` and `currentBranch` rethrow
      // `AbortError`; `mergeBase` and `diffWorktree` propagate it via
      // `execFile`'s native signal option.
      const signal = getCurrentSignal();
      let resolvedBase: string | null = null;
      for (const candidate of candidates) {
        if (await refExists(record.worktreePath, candidate, signal)) {
          resolvedBase = candidate;
          break;
        }
      }
      if (resolvedBase === null) {
        throw badArgs(
          `no base ref resolved for worker '${args.workerId}': tried ${candidates.join(', ')}`,
        );
      }
      try {
        const sha = await mergeBase(record.worktreePath, resolvedBase, signal);
        const [diffResult, branch] = await Promise.all([
          diffWorktree({
            worktreePath: record.worktreePath,
            baseRef: sha,
            capBytes: cap,
            ...(signal !== undefined ? { signal } : {}),
          }),
          currentBranch(record.worktreePath, signal),
        ]);
        return {
          resolvedBase,
          mergeBaseSha: sha,
          branch,
          diff: diffResult.diff,
          bytes: diffResult.bytes,
          truncated: diffResult.truncated,
          cappedAt: diffResult.truncated ? cap : null,
          files: diffResult.files.map((f) => ({ path: f.path, status: f.status })),
        };
      } catch (err) {
        if (err instanceof GitOpsError) {
          throw new RpcArgError(
            'bad_args',
            `git error: ${err.message}${err.stderr ? ` :: ${err.stderr.trim().slice(0, 200)}` : ''}`,
          );
        }
        throw err;
      }
    },
  });

  const questions = createRPCController({
    list(args?: QuestionsListArgs): QuestionSnapshot[] {
      return questionStore.snapshots(args ?? {});
    },
    get(id: string): QuestionSnapshot | null {
      requireString(id, 'id');
      return questionStore.snapshot(id) ?? null;
    },
    answer(args: QuestionsAnswerArgs): QuestionSnapshot {
      requireString(args?.id, 'id');
      requireString(args?.answer, 'answer');
      const record = questionStore.answer(args.id, args.answer);
      const snap = questionStore.snapshot(record.id);
      if (snap === undefined) {
        throw new Error(`questions.answer: snapshot missing for '${record.id}' after update`);
      }
      return snap;
    },
  });

  const waves = createRPCController({
    list(args?: { projectId?: string; finished?: boolean }): WaveSnapshot[] {
      return waveStore.snapshots(args ?? {});
    },
    get(id: string): WaveSnapshot | null {
      requireString(id, 'id');
      return waveStore.snapshot(id) ?? null;
    },
  });

  const mode = createRPCController({
    get(): ModeSnapshot {
      return { mode: modeController.mode };
    },
    /**
     * Phase 3H.2 — flip Symphony's `modelMode` (`opus` | `mixed`) and
     * persist to `~/.symphony/config.json`. Routes through
     * `applyPatchToDisk` so this write is serialized with concurrent
     * `setConfig` calls in the same process.
     *
     * Architectural note: 3H.2's TUI funnels writes through the
     * in-process `<ConfigProvider>` (which also calls `applyPatchToDisk`),
     * NOT this RPC. The RPC exists for future remote clients. Two
     * processes writing concurrently is a known constraint — see the
     * `applyPatchToDisk` docstring for the cross-process plan.
     *
     * Audit M3: `loadConfig` warnings (malformed file, salvaged fields)
     * are returned in the result so the caller can surface them. Without
     * this, an RPC-driven flip would silently overwrite a user-edited
     * file with defaults+modelMode and the user would have no signal.
     */
    async setModel(args: ModeSetModelArgs): Promise<ModeSetModelResult> {
      if (args?.modelMode !== 'opus' && args?.modelMode !== 'mixed') {
        throw badArgs('modelMode must be "opus" or "mixed"');
      }
      const pre = await loadConfig();
      const warnings: readonly string[] =
        pre.source.kind === 'file' ? pre.source.warnings : [];
      const result = await applyPatchToDisk({ modelMode: args.modelMode });
      return { modelMode: result.config.modelMode, warnings };
    },
  });

  /**
   * Phase 3H.3 — `notifications.flushAwayDigest` is the TUI's bridge
   * for delivering a single batched-digest toast when the user toggles
   * `awayMode` from `true` back to `false`. The TUI watches the config
   * field via `useEffect`; on the true→false edge it calls this
   * procedure. The dispatcher itself drains its accumulator + resets
   * the running tally; it is safe to call repeatedly (idempotent on
   * an empty buffer). When `RouterDeps.notificationDispatcher` is
   * undefined (test rigs that don't inject one), the call resolves a
   * no-op so client code doesn't need to branch.
   */
  const notifications = createRPCController({
    async flushAwayDigest(): Promise<void> {
      if (deps.notificationDispatcher === undefined) return;
      await deps.notificationDispatcher.flushAwayDigest();
    },
  });

  /**
   * Phase 3M — runtime context surface. Today only `setAwayMode` lives
   * here, but future runtime flags that the TUI needs to push into the
   * server's dispatch context (`automationContext`, per-session tier
   * overrides, etc.) should land here too rather than scattering across
   * other namespaces.
   *
   * `setAwayMode` is best-effort: when `deps.setDispatchAwayMode` is
   * absent (legacy test rigs that don't construct a context cursor),
   * the procedure still validates args and echoes back the value so
   * client code can be uniform across rig types. The CLI server always
   * wires the real setter.
   */
  const runtime = createRPCController({
    async setAwayMode(args: RuntimeSetAwayModeArgs): Promise<RuntimeSetAwayModeResult> {
      if (typeof args?.awayMode !== 'boolean') {
        throw badArgs('awayMode must be a boolean');
      }
      deps.setDispatchAwayMode?.(args.awayMode);
      return { awayMode: args.awayMode };
    },
  });

  /**
   * Phase 3L — task queue panel surface. `list` returns the flat
   * cross-project queue sorted by enqueue timestamp; `cancel` removes
   * a pending entry and rejects the caller's spawn promise;
   * `reorder` swaps a pending entry with its same-project neighbor.
   *
   * All three return `not_found` if `workerLifecycle` is missing from
   * `RouterDeps` (legacy test rigs). The CLI server always wires it.
   */
  const queue = createRPCController({
    list(): readonly PendingSpawnSnapshot[] {
      if (deps.workerLifecycle === undefined) {
        throw notFound('queue subsystem not configured');
      }
      return deps.workerLifecycle.listPendingGlobal();
    },
    cancel(args: QueueCancelArgs): QueueCancelResult {
      requireString(args?.recordId, 'recordId');
      if (deps.workerLifecycle === undefined) {
        throw notFound('queue subsystem not configured');
      }
      return deps.workerLifecycle.cancelQueued(args.recordId);
    },
    reorder(args: QueueReorderArgs): QueueReorderResult {
      requireString(args?.recordId, 'recordId');
      if (args?.direction !== 'up' && args?.direction !== 'down') {
        throw badArgs('direction must be "up" or "down"');
      }
      if (deps.workerLifecycle === undefined) {
        throw notFound('queue subsystem not configured');
      }
      return deps.workerLifecycle.reorderQueued(args.recordId, args.direction);
    },
  });

  return createRPCRouter({
    projects,
    tasks,
    workers,
    questions,
    waves,
    mode,
    notifications,
    queue,
    runtime,
  });
}

export type SymphonyRouter = ReturnType<typeof createSymphonyRouter>;

// ── Helpers ───────────────────────────────────────────────────────────

class RpcArgError extends Error {
  readonly code: 'bad_args' | 'not_found';
  constructor(code: 'bad_args' | 'not_found', message: string) {
    super(message);
    this.name = 'RpcArgError';
    this.code = code;
  }
}

function badArgs(message: string): RpcArgError {
  return new RpcArgError('bad_args', message);
}

function notFound(message: string): RpcArgError {
  return new RpcArgError('not_found', message);
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw badArgs(`${name} must be a non-empty string`);
  }
}

/**
 * Phase 2B.2 m7 — defense-in-depth length caps at the RPC router boundary.
 * The wire-frame cap (`MAX_FRAME_BYTES = 1 MiB`) bounds total per-frame
 * cost; per-field caps prevent one giant string from exhausting the
 * SQLite TEXT column in `taskStore.create`/`update` or chewing render
 * budget in the TUI. Caps are generous; the goal is `bad_args` rejection
 * for runaway data, not a UX limit.
 */
const TASKS_DESCRIPTION_MAX = 16 * 1024;
const TASKS_NOTES_MAX = 64 * 1024;

/**
 * Phase 3J — `workers.diff` body cap bounds. Default 256 KB matches
 * what the TUI scroll view can actually consume comfortably; 512 KB max
 * leaves headroom under the 1 MiB WS frame budget for the JSON
 * envelope. Min 4 KB so callers can't dial in absurdly small caps.
 */
const WORKERS_DIFF_CAP_MIN = 4_000;
const WORKERS_DIFF_CAP_DEFAULT = 256_000;
const WORKERS_DIFF_CAP_MAX = 512_000;

function requireBoundedString(
  value: unknown,
  name: string,
  maxBytes: number,
): asserts value is string {
  requireString(value, name);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw badArgs(`${name} exceeds ${maxBytes}-byte cap`);
  }
}

function coerceTaskFilter(args: TasksListArgs | undefined): TaskListFilter {
  if (args === undefined) return {};
  const filter: TaskListFilter = {
    ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
  };
  return filter;
}

// Re-export a sentinel for AutonomyTier so client SDKs don't have to
// reach into orchestrator/types.js for type-only consumers.
export type { AutonomyTier };
