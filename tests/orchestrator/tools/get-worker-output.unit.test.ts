import { describe, it, expect } from 'vitest';
import { makeGetWorkerOutputTool } from '../../../src/orchestrator/tools/get-worker-output.js';
import {
  CircularBuffer,
  type WorkerRegistry,
  type WorkerRecord,
} from '../../../src/orchestrator/worker-registry.js';
import type { StreamEvent, WorkerCompletionReport } from '../../../src/workers/types.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';

const ctx: DispatchContext = {
  mode: 'act',
  tier: 1,
  awayMode: false,
  automationContext: false,
};

function report(over: Partial<WorkerCompletionReport> = {}): WorkerCompletionReport {
  return {
    did: ['a', 'b', 'c'],
    skipped: ['s1'],
    blockers: [],
    open_questions: [],
    audit: 'PASS',
    cite: [],
    tests_run: [],
    preview_url: null,
    ...over,
  };
}

/** Real CircularBuffer (the formatting is the unit under test); the
 *  registry is a trivial lookup so a minimal stub is honest here. */
function toolFor(events: StreamEvent[]): ReturnType<typeof makeGetWorkerOutputTool> {
  const buffer = new CircularBuffer<StreamEvent>(2000);
  for (const e of events) buffer.push(e);
  const record = { id: 'wk-1', status: 'completed', buffer } as unknown as WorkerRecord;
  const registry = { get: (id: string) => (id === 'wk-1' ? record : undefined) } as unknown as WorkerRegistry;
  return makeGetWorkerOutputTool({ registry });
}

async function textOf(
  tool: ReturnType<typeof makeGetWorkerOutputTool>,
): Promise<string> {
  const res = await tool.handler({ worker_id: 'wk-1' } as never, ctx);
  return res.content
    .map((c: { type: string; text?: string }) =>
      'text' in c && typeof c.text === 'string' ? c.text : '',
    )
    .join('');
}

describe('get_worker_output — Phase 4E completion formatting', () => {
  it('renders the full counts header so Maestro reads the whole report', async () => {
    const tool = toolFor([
      {
        type: 'structured_completion',
        report: report({
          did: ['a', 'b', 'c'],
          skipped: ['s1'],
          blockers: [],
          open_questions: ['q1', 'q2'],
          tests_run: ['pnpm test: PASS'],
          preview_url: null,
        }),
        raw: '{}',
      },
    ]);
    const text = await textOf(tool);
    expect(text).toContain(
      '[completion] audit=PASS did=3 skipped=1 blockers=0 open_questions=2 tests=1 preview=-',
    );
  });

  it('surfaces open_questions CONTENT (rule #7: Maestro must be able to read them)', async () => {
    const tool = toolFor([
      {
        type: 'structured_completion',
        report: report({
          open_questions: ['Should we migrate to Postgres?', 'Is the poller still needed?'],
        }),
        raw: '{}',
      },
    ]);
    const text = await textOf(tool);
    expect(text).toContain(
      'open_questions: Should we migrate to Postgres? | Is the poller still needed?',
    );
  });

  it('surfaces blockers content and preview_url (rule #9 / UI projects)', async () => {
    const tool = toolFor([
      {
        type: 'structured_completion',
        report: report({
          audit: 'FAIL',
          blockers: ['schema drift in 0007'],
          preview_url: 'http://localhost:5173',
        }),
        raw: '{}',
      },
    ]);
    const text = await textOf(tool);
    expect(text).toContain('audit=FAIL');
    expect(text).toContain('blockers: schema drift in 0007');
    expect(text).toContain('preview=http://localhost:5173');
  });

  it('caps runaway lists at 10 entries with a +N more summary', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `q${i + 1}`);
    const tool = toolFor([
      { type: 'structured_completion', report: report({ open_questions: many }), raw: '{}' },
    ]);
    const text = await textOf(tool);
    expect(text).toContain('q1 | q2 | q3 | q4 | q5 | q6 | q7 | q8 | q9 | q10 | …(+15 more)');
    expect(text).not.toContain('q11 ');
  });

  it('omits the open_questions/blockers detail lines when those arrays are empty', async () => {
    const tool = toolFor([
      { type: 'structured_completion', report: report({ open_questions: [], blockers: [] }), raw: '{}' },
    ]);
    const text = await textOf(tool);
    expect(text).toContain('open_questions=0');
    expect(text).not.toContain('  open_questions:');
    expect(text).not.toContain('  blockers:');
  });
});
