import { describe, it, expect } from 'vitest';
import {
  routeWorkerOpenQuestions,
  OPEN_QUESTION_ACK,
} from '../../src/orchestrator/open-questions-router.js';
import { QuestionRegistry } from '../../src/state/question-registry.js';
import type { WorkerRecord } from '../../src/orchestrator/worker-registry.js';
import type { StreamEvent, WorkerCompletionReport } from '../../src/workers/types.js';

function makeRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  const events: StreamEvent[] = [];
  const buffer = {
    tail: (_n: number): StreamEvent[] => events.slice(),
    push: (e: StreamEvent): void => {
      events.push(e);
    },
    size: () => events.length,
    total: () => events.length,
    clear: () => {
      events.length = 0;
    },
    capacity: 2000,
  };
  return {
    id: 'wk-1',
    projectPath: '/proj/app',
    projectId: 'proj-1',
    taskId: null,
    worktreePath: '/proj/app/.symphony/worktrees/wk-1',
    role: 'implementer',
    featureIntent: 'add the websocket reconnect',
    taskDescription: 'reconnect',
    autonomyTier: 1 as const,
    dependsOn: [],
    createdAt: new Date(0).toISOString(),
    status: 'completed',
    buffer: buffer as never,
    worker: {} as never,
    detach: () => {},
    ...overrides,
  } as WorkerRecord;
}

function push(record: WorkerRecord, e: StreamEvent): void {
  (record.buffer as unknown as { push(e: StreamEvent): void }).push(e);
}

function report(over: Partial<WorkerCompletionReport> = {}): WorkerCompletionReport {
  return {
    did: ['x'],
    skipped: [],
    blockers: [],
    open_questions: [],
    audit: 'PASS',
    cite: [],
    tests_run: [],
    preview_url: null,
    ...over,
  };
}

describe('routeWorkerOpenQuestions', () => {
  it('routes each open_question as an advisory, auto-acknowledged question', () => {
    const store = new QuestionRegistry();
    const rec = makeRecord();
    push(rec, { type: 'assistant_text', text: 'done' });
    push(rec, {
      type: 'structured_completion',
      report: report({
        open_questions: ['Should auth move to middleware?', 'Drop the legacy poller?'],
      }),
      raw: '{}',
    });

    const routed = routeWorkerOpenQuestions(rec, store);

    expect(routed).toBe(2);
    const all = store.list();
    expect(all).toHaveLength(2);
    for (const q of all) {
      expect(q.urgency).toBe('advisory');
      expect(q.workerId).toBe('wk-1');
      expect(q.projectId).toBe('proj-1');
      expect(q.answered).toBe(true); // auto-acknowledged
      expect(q.answer).toBe(OPEN_QUESTION_ACK);
      expect(q.context).toContain('add the websocket reconnect');
      expect(q.context).toContain('not acted on');
    }
    expect(all.map((q) => q.question)).toEqual([
      'Should auth move to middleware?',
      'Drop the legacy poller?',
    ]);
  });

  it('auto-acknowledged advisory questions never enter the blocking (answered:false) set', () => {
    const store = new QuestionRegistry();
    const rec = makeRecord();
    push(rec, {
      type: 'structured_completion',
      report: report({ open_questions: ['noted but not blocking'] }),
      raw: '{}',
    });

    routeWorkerOpenQuestions(rec, store);

    // The StatusBar `Q:` count + 3E popup both poll `answered:false`.
    expect(store.list({ answered: false })).toHaveLength(0);
    expect(store.list({ answered: true })).toHaveLength(1);
  });

  it('returns 0 when there is no structured_completion event', () => {
    const store = new QuestionRegistry();
    const rec = makeRecord();
    push(rec, { type: 'assistant_text', text: 'no report here' });
    expect(routeWorkerOpenQuestions(rec, store)).toBe(0);
    expect(store.size()).toBe(0);
  });

  it('returns 0 and enqueues nothing when open_questions is empty', () => {
    const store = new QuestionRegistry();
    const rec = makeRecord();
    push(rec, {
      type: 'structured_completion',
      report: report({ open_questions: [] }),
      raw: '{}',
    });
    expect(routeWorkerOpenQuestions(rec, store)).toBe(0);
    expect(store.size()).toBe(0);
  });

  it('filters blank / whitespace-only entries', () => {
    const store = new QuestionRegistry();
    const rec = makeRecord();
    push(rec, {
      type: 'structured_completion',
      report: report({ open_questions: ['  ', '', '  real one  '] }),
      raw: '{}',
    });
    expect(routeWorkerOpenQuestions(rec, store)).toBe(1);
    expect(store.list()[0]?.question).toBe('real one');
  });

  it('omits projectId when the worker has none (unregistered absolute path)', () => {
    const store = new QuestionRegistry();
    const rec = makeRecord({ projectId: null });
    push(rec, {
      type: 'structured_completion',
      report: report({ open_questions: ['q'] }),
      raw: '{}',
    });
    routeWorkerOpenQuestions(rec, store);
    expect(store.list()[0]?.projectId).toBeUndefined();
  });

  it('uses the LAST structured_completion event (resume / multi-report)', () => {
    const store = new QuestionRegistry();
    const rec = makeRecord();
    push(rec, {
      type: 'structured_completion',
      report: report({ open_questions: ['stale from first run'] }),
      raw: '{}',
    });
    push(rec, {
      type: 'structured_completion',
      report: report({ open_questions: ['fresh from final run'] }),
      raw: '{}',
    });
    routeWorkerOpenQuestions(rec, store);
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.question).toBe('fresh from final run');
  });
});
