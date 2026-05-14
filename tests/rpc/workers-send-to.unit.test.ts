import { describe, expect, it } from 'vitest';
import { createSymphonyRouter } from '../../src/rpc/router-impl.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { WaveRegistry } from '../../src/orchestrator/research-wave-registry.js';
import {
  CircularBuffer,
  WorkerRegistry,
  type WorkerRecord,
} from '../../src/orchestrator/worker-registry.js';
import { ModeController } from '../../src/orchestrator/mode.js';
import type { StreamEvent, Worker } from '../../src/workers/types.js';

/**
 * Phase 3S — `workers.sendTo` RPC handler tests. The handler is the
 * TUI-facing equivalent of the `send_to_worker` MCP tool: queues a
 * follow-up message to a running worker's stdin via
 * `record.worker.sendFollowup(message)`.
 *
 * Mirrors the MCP tool's preconditions (status === 'running', record
 * exists) so the TUI and Maestro see the same shape on the same
 * underlying registry. Diverges only in transport (RPC vs MCP) and in
 * size cap (4 KB UTF-8 — bounds runaway TUI paste).
 */

interface SendFollowupCapture {
  readonly calls: string[];
}

function stubWorker(capture: SendFollowupCapture): Worker {
  return {
    id: 'wk',
    sessionId: undefined,
    status: 'running',
    events: (async function* () {})(),
    sendFollowup: (text: string) => {
      capture.calls.push(text);
    },
    endInput: () => {},
    kill: () => {},
    waitForExit: async () => ({
      status: 'running' as const,
      exitCode: 0,
      signal: null,
      durationMs: 0,
    }),
  } as unknown as Worker;
}

function makeRecord(
  overrides: Partial<WorkerRecord> & { capture?: SendFollowupCapture },
): { record: WorkerRecord; capture: SendFollowupCapture } {
  const capture = overrides.capture ?? { calls: [] };
  const record: WorkerRecord = {
    id: overrides.id ?? 'wk-1',
    projectPath: overrides.projectPath ?? '/tmp/p',
    projectId: overrides.projectId ?? null,
    taskId: null,
    worktreePath: overrides.worktreePath ?? '/tmp/p',
    role: 'implementer',
    featureIntent: 'feature',
    taskDescription: 'task',
    autonomyTier: 2,
    dependsOn: [],
    status: overrides.status ?? 'running',
    createdAt: new Date().toISOString(),
    worker: overrides.worker ?? stubWorker(capture),
    buffer: new CircularBuffer<StreamEvent>(10),
    detach: () => {},
  };
  return { record, capture };
}

function makeRouter(workerRegistry: WorkerRegistry) {
  return createSymphonyRouter({
    projectStore: new ProjectRegistry(),
    taskStore: new TaskRegistry({ projectStore: new ProjectRegistry() }),
    questionStore: new QuestionRegistry(),
    waveStore: new WaveRegistry(),
    workerRegistry,
    modeController: new ModeController({ initial: 'plan' }),
  });
}

describe('workers.sendTo (3S)', () => {
  it('queues a follow-up message via record.worker.sendFollowup', async () => {
    const workerRegistry = new WorkerRegistry();
    const { record, capture } = makeRecord({ id: 'wk-1' });
    workerRegistry.register(record);
    const router = makeRouter(workerRegistry);
    const result = await router.workers.sendTo({
      workerId: 'wk-1',
      message: 'also check the audit.log path',
    });
    expect(result.workerId).toBe('wk-1');
    expect(result.bytes).toBeGreaterThan(0);
    expect(capture.calls).toEqual(['also check the audit.log path']);
  });

  it('rejects when the worker is not registered (not_found)', () => {
    const router = makeRouter(new WorkerRegistry());
    expect(() =>
      router.workers.sendTo({ workerId: 'ghost', message: 'hi' }),
    ).toThrow(/not registered/);
  });

  it('rejects when the worker is in a terminal status (bad_args)', () => {
    const workerRegistry = new WorkerRegistry();
    const { record } = makeRecord({ id: 'wk-done', status: 'completed' });
    workerRegistry.register(record);
    const router = makeRouter(workerRegistry);
    expect(() =>
      router.workers.sendTo({ workerId: 'wk-done', message: 'hi' }),
    ).toThrow(/completed/);
  });

  it('rejects an empty message', () => {
    const workerRegistry = new WorkerRegistry();
    const { record } = makeRecord({ id: 'wk-1' });
    workerRegistry.register(record);
    const router = makeRouter(workerRegistry);
    expect(() =>
      router.workers.sendTo({ workerId: 'wk-1', message: '' }),
    ).toThrow(/message/);
  });

  it('rejects a message exceeding the 4 KB UTF-8 cap', () => {
    const workerRegistry = new WorkerRegistry();
    const { record } = makeRecord({ id: 'wk-1' });
    workerRegistry.register(record);
    const router = makeRouter(workerRegistry);
    const oversize = 'x'.repeat(5000);
    expect(() =>
      router.workers.sendTo({ workerId: 'wk-1', message: oversize }),
    ).toThrow(/cap/);
  });

  it('accepts a message at exactly 4 KB UTF-8', async () => {
    const workerRegistry = new WorkerRegistry();
    const { record, capture } = makeRecord({ id: 'wk-1' });
    workerRegistry.register(record);
    const router = makeRouter(workerRegistry);
    const atCap = 'a'.repeat(4 * 1024);
    const result = await router.workers.sendTo({ workerId: 'wk-1', message: atCap });
    expect(result.bytes).toBe(4 * 1024);
    expect(capture.calls).toHaveLength(1);
  });

  it('rejects a missing workerId arg', () => {
    const router = makeRouter(new WorkerRegistry());
    expect(() =>
      router.workers.sendTo({
        message: 'hi',
      } as unknown as { workerId: string; message: string }),
    ).toThrow(/workerId/);
  });
});
