/**
 * Phase 4E production scenario — worker structured completion: the
 * `display` field is carried end-to-end and `open_questions` route into
 * the real QuestionRegistry as advisory, auto-acknowledged entries.
 *
 * REAL `createWorkerLifecycle` + REAL `WorkerRegistry` + REAL
 * `QuestionRegistry`, wired with the SAME `onWorkerStatusChange` closure
 * shape `server.ts` uses (it calls `routeWorkerOpenQuestions`). The
 * worker is spawned via the REAL `makeSpawnWorkerTool` handler. The
 * report event is produced by the REAL `scanForCompletionReport` (the
 * exact logic `stream-parser.ts` uses) — only the `claude` subprocess /
 * NDJSON transport is stubbed (standard Track-1 boundary).
 *
 * Ground Truth Is Observable: assertions are on emitted events, stored
 * question records, and rendered tool output — never on the semantic
 * trust of the worker's self-reported `audit` / `tests_run`.
 */
import { describe, expect, it } from 'vitest';

import { createWorkerLifecycle } from '../../src/orchestrator/worker-lifecycle.js';
import { WorkerRegistry } from '../../src/orchestrator/worker-registry.js';
import { makeSpawnWorkerTool } from '../../src/orchestrator/tools/spawn-worker.js';
import { makeGetWorkerOutputTool } from '../../src/orchestrator/tools/get-worker-output.js';
import {
  routeWorkerOpenQuestions,
  OPEN_QUESTION_ACK,
} from '../../src/orchestrator/open-questions-router.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import { scanForCompletionReport } from '../../src/workers/completion-report.js';
import { DEFAULT_DISPATCH_CONTEXT } from '../../src/orchestrator/capabilities.js';
import type { DispatchContext } from '../../src/orchestrator/types.js';
import type { WorkerManager } from '../../src/workers/manager.js';
import type {
  StreamEvent,
  Worker,
  WorkerConfig,
  WorkerExitInfo,
} from '../../src/workers/types.js';
import type { WorktreeManager } from '../../src/worktree/manager.js';
import type {
  CreateWorktreeOptions,
  WorktreeInfo,
} from '../../src/worktree/types.js';

function ctx(): DispatchContext {
  return { ...DEFAULT_DISPATCH_CONTEXT, mode: 'act' };
}

/** The verbatim worker-common-suffix JSON contract a worker emits in its
 *  final message. Run through the REAL parser to produce the event the
 *  stream-parser would emit. */
function finalMessage(report: Record<string, unknown>): string {
  return `All done.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
}

function completionEvent(report: Record<string, unknown>): StreamEvent {
  const scan = scanForCompletionReport(finalMessage(report));
  if (scan.kind !== 'valid' || scan.report === undefined || scan.raw === undefined) {
    throw new Error(`fixture is not a valid completion report: ${scan.kind}`);
  }
  // Construct exactly as stream-parser.ts:149-159 does.
  return { type: 'structured_completion', report: scan.report, raw: scan.raw };
}

class EmittingStubWorker implements Worker {
  readonly id: string;
  sessionId: string | undefined = undefined;
  status: WorkerExitInfo['status'] = 'running';
  events: AsyncIterable<StreamEvent>;
  private readonly drained: Promise<void>;

  constructor(id: string, toEmit: StreamEvent[]) {
    this.id = id;
    let resolveDrained!: () => void;
    this.drained = new Promise<void>((r) => {
      resolveDrained = r;
    });
    this.events = (async function* () {
      try {
        for (const e of toEmit) yield e;
      } finally {
        // Runs after the tap's synchronous `buffer.push` for the last
        // yielded event — guarantees the buffer holds the completion
        // before `waitForExit` lets the exit hook fire.
        resolveDrained();
      }
    })();
  }
  sendFollowup(): void {}
  endInput(): void {}
  kill(): void {}
  async waitForExit(): Promise<WorkerExitInfo> {
    await this.drained;
    await new Promise((r) => setImmediate(r));
    return { status: 'completed', exitCode: 0, signal: null, durationMs: 1234 };
  }
}

function makeWm(emit: StreamEvent[]): WorkerManager {
  return {
    spawn: async (cfg: WorkerConfig): Promise<Worker> =>
      new EmittingStubWorker(cfg.id, emit),
    list: () => [],
    get: () => undefined,
    shutdown: async () => {},
  } as unknown as WorkerManager;
}

function stubWt(): WorktreeManager {
  return {
    create: async (opts: CreateWorktreeOptions): Promise<WorktreeInfo> => ({
      id: opts.workerId,
      path: `/wt/${opts.workerId}`,
      branch: `b/${opts.workerId}`,
      baseRef: 'refs/heads/main',
      projectPath: opts.projectPath,
      createdAt: '2026-05-17T00:00:00.000Z',
    }),
    list: async () => [],
    remove: async () => {},
    removeIfClean: async () => true,
    status: async () => ({
      hasChanges: false,
      staged: [],
      unstaged: [],
      untracked: [],
    }),
  } as unknown as WorktreeManager;
}

async function waitFor(
  pred: () => boolean,
  timeoutMs = 4000,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return pred();
}

const CARD_DISPLAY = {
  root: 'c',
  elements: {
    c: { type: 'Card', props: { title: 'Run Summary' }, children: ['t'] },
    t: { type: 'Text', props: { text: '3 files changed' } },
  },
};

async function spawnAndComplete(
  emit: StreamEvent[],
  questionStore: QuestionRegistry,
): Promise<{ registry: WorkerRegistry; workerId: string }> {
  const registry = new WorkerRegistry();
  const lifecycle = createWorkerLifecycle({
    registry,
    workerManager: makeWm(emit),
    worktreeManager: stubWt(),
    // Exactly server.ts's onWorkerStatusChange shape (4E call).
    onWorkerStatusChange: (record) => {
      routeWorkerOpenQuestions(record, questionStore);
    },
  });
  const tool = makeSpawnWorkerTool({
    registry,
    lifecycle,
    resolveProjectPath: () => '/p/proj',
  });
  const res = await tool.handler(
    {
      project: undefined,
      task_description: 'land the websocket reconnect',
      role: 'implementer',
      model: undefined,
      depends_on: undefined,
      autonomy_tier: undefined,
      task_id: undefined,
    },
    ctx(),
  );
  expect(res.isError).toBeFalsy();
  const workerId = registry.list()[0]!.id;
  await waitFor(() => registry.get(workerId)?.status === 'completed');
  return { registry, workerId };
}

describe('Phase 4E scenario — structured completion: display + open_questions routing', () => {
  it('Section 1+2 — report reaches the buffer; open_questions route advisory + auto-acked', async () => {
    const questionStore = new QuestionRegistry();
    const event = completionEvent({
      did: ['wired the reconnect at src/ws/client.ts:42'],
      skipped: [],
      blockers: [],
      open_questions: [
        'the legacy poller looks dead — worth removing?',
        'should auth move to middleware?',
      ],
      audit: 'PASS',
      cite: ['src/ws/client.ts:42'],
      tests_run: ['pnpm test: PASS'],
      preview_url: null,
      display: CARD_DISPLAY,
    });
    const { registry, workerId } = await spawnAndComplete([event], questionStore);

    // --- Section 1: parser → tap → buffer, readable by Maestro ---
    const getOut = makeGetWorkerOutputTool({ registry });
    const out = await getOut.handler({ worker_id: workerId } as never, ctx());
    const text = out.content.map((c) => ('text' in c ? c.text : '')).join('');
    expect(text).toContain('[completion] audit=PASS');
    expect(text).toContain('open_questions=2');
    expect(text).toContain(
      'open_questions: the legacy poller looks dead — worth removing? | should auth move to middleware?',
    );

    // display carried end-to-end (advisory field, observable on the event)
    const events = registry
      .get(workerId)!
      .buffer.tail(registry.get(workerId)!.buffer.size());
    const completion = events.find((e) => e.type === 'structured_completion');
    expect(completion).toBeDefined();
    expect(
      (completion as { report: { display: unknown } }).report.display,
    ).toEqual(CARD_DISPLAY);

    // --- Section 2: open_questions routed to the real QuestionRegistry ---
    const routed = questionStore.list();
    expect(routed).toHaveLength(2);
    for (const q of routed) {
      expect(q.urgency).toBe('advisory');
      expect(q.workerId).toBe(workerId);
      expect(q.answered).toBe(true);
      expect(q.answer).toBe(OPEN_QUESTION_ACK);
      // featureIntent is the auto-derived kebab slug of the task.
      expect(q.context).toContain('land-the-websocket-reconnect');
      expect(q.context).toContain('not acted on');
    }
    expect(routed.map((q) => q.question)).toEqual([
      'the legacy poller looks dead — worth removing?',
      'should auth move to middleware?',
    ]);

    // Non-blocking invariant: nothing in the answered:false set (the
    // 3E popup + StatusBar `Q:` count both poll that).
    expect(questionStore.list({ answered: false })).toHaveLength(0);
  });

  it('Section 3 — a malformed `display` never blocks parsing, routing, or audit', async () => {
    const questionStore = new QuestionRegistry();
    const event = completionEvent({
      did: ['fixed it'],
      skipped: [],
      blockers: [],
      open_questions: ['noticed an adjacent flake — out of scope'],
      audit: 'PASS',
      cite: ['x:1'],
      tests_run: [],
      preview_url: null,
      display: 'I forgot to emit a real json-render spec',
    });
    const { registry, workerId } = await spawnAndComplete([event], questionStore);

    const getOut = makeGetWorkerOutputTool({ registry });
    const out = await getOut.handler({ worker_id: workerId } as never, ctx());
    const text = out.content.map((c) => ('text' in c ? c.text : '')).join('');
    // Textual completion still rendered despite the bad display.
    expect(text).toContain('[completion] audit=PASS');
    expect(text).toContain('open_questions=1');

    // open_question still routed advisory + auto-acked.
    const routed = questionStore.list();
    expect(routed).toHaveLength(1);
    expect(routed[0]?.urgency).toBe('advisory');
    expect(routed[0]?.answered).toBe(true);
    expect(questionStore.list({ answered: false })).toHaveLength(0);
  });
});
