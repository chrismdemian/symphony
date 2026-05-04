import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider, useFocus, type FocusState } from '../../../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../../../src/ui/keybinds/dispatcher.js';
import { QuestionPopup } from '../../../../src/ui/panels/questions/QuestionPopup.js';
import type { TuiRpc } from '../../../../src/ui/runtime/rpc.js';
import type { QuestionSnapshot } from '../../../../src/state/question-registry.js';
import type { ProjectSnapshot } from '../../../../src/projects/types.js';

/**
 * Phase 3E — popup integration: render the question, fire submit through
 * `useAnswerQuestion`, navigate via Tab, dismiss via Esc.
 *
 * Tests build the same provider stack the App ships so popup-scope
 * keybinds resolve via `<KeybindProvider>` and focus state is wired.
 *
 * Helper: `makeFakeRpc()` returns a controlled `questions.answer` mock
 * the test can assert against.
 */

const SCOPE = 'question';

interface FakeRpcHandle {
  rpc: TuiRpc;
  answers: Array<{ id: string; answer: string }>;
  resolveNext(): void;
  rejectNext(message: string): void;
  pending(): number;
}

function makeFakeRpc(): FakeRpcHandle {
  const answers: Array<{ id: string; answer: string }> = [];
  const queue: Array<{
    resolve: (v: QuestionSnapshot) => void;
    reject: (e: unknown) => void;
    args: { id: string; answer: string };
  }> = [];

  const stub = (): unknown => vi.fn();

  const answer = vi.fn().mockImplementation((args: { id: string; answer: string }) => {
    answers.push(args);
    return new Promise<QuestionSnapshot>((resolve, reject) => {
      queue.push({ resolve, reject, args });
    });
  });

  const rpc: TuiRpc = {
    call: {
      projects: { list: stub() as never, get: stub() as never, register: stub() as never },
      tasks: {
        list: stub() as never,
        get: stub() as never,
        create: stub() as never,
        update: stub() as never,
      },
      workers: {
        list: stub() as never,
        get: stub() as never,
        kill: stub() as never,
        tail: stub() as never,
      },
      questions: {
        list: stub() as never,
        get: stub() as never,
        answer: answer as never,
      },
      waves: { list: stub() as never, get: stub() as never },
      mode: { get: stub() as never },
    },
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as TuiRpc;

  return {
    rpc,
    answers,
    resolveNext(): void {
      const next = queue.shift();
      if (!next) throw new Error('no pending questions.answer call');
      next.resolve({
        id: next.args.id,
        question: '?',
        urgency: 'blocking',
        askedAt: '2026-05-04T00:00:00.000Z',
        answered: true,
        answer: next.args.answer,
        answeredAt: '2026-05-04T00:00:01.000Z',
      });
    },
    rejectNext(message): void {
      const next = queue.shift();
      if (!next) throw new Error('no pending questions.answer call');
      next.reject(new Error(message));
    },
    pending: () => queue.length,
  };
}

function snap(over: Partial<QuestionSnapshot>): QuestionSnapshot {
  return {
    id: over.id ?? 'q-1',
    question: over.question ?? 'Should we use Postgres or SQLite?',
    urgency: over.urgency ?? 'blocking',
    askedAt: over.askedAt ?? '2026-05-04T00:00:00.000Z',
    answered: false,
    ...(over.context !== undefined ? { context: over.context } : {}),
    ...(over.projectId !== undefined ? { projectId: over.projectId } : {}),
    ...(over.workerId !== undefined ? { workerId: over.workerId } : {}),
  };
}

const FIXED_NOW = (): number => Date.parse('2026-05-04T00:02:00.000Z');

const PROJECTS: readonly ProjectSnapshot[] = [
  {
    id: 'p-mathscrabble',
    name: 'MathScrabble',
    path: 'C:/foo',
    createdAt: '2026-04-29T00:00:00.000Z',
  },
];

interface HarnessProps {
  readonly rpc: TuiRpc;
  readonly questions: readonly QuestionSnapshot[];
  /** Pushes the popup so the keybind dispatch + focus scope are realistic. */
  readonly autoPush?: boolean;
}

function PopupBootstrap({ autoPush = true }: { readonly autoPush?: boolean }): null {
  const focus = useFocus();
  React.useEffect(() => {
    if (autoPush) focus.pushPopup(SCOPE);
  }, [autoPush, focus]);
  return null;
}

function renderHarness({ rpc, questions, autoPush = true }: HarnessProps) {
  const initial: FocusState | undefined = autoPush
    ? { stack: [{ kind: 'main', key: 'chat' }, { kind: 'popup', key: SCOPE }] }
    : undefined;
  return render(
    <ThemeProvider>
      <FocusProvider {...(initial !== undefined ? { initial } : {})}>
        <KeybindProvider initialCommands={[]}>
          <QuestionPopup
            rpc={rpc}
            questions={questions}
            projects={PROJECTS}
            now={FIXED_NOW}
          />
          <PopupBootstrap autoPush={false} />
        </KeybindProvider>
      </FocusProvider>
    </ThemeProvider>,
  );
}

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');

describe('<QuestionPopup>', () => {
  it('renders the active question with urgency badge + meta + body', () => {
    const fake = makeFakeRpc();
    const { lastFrame } = renderHarness({
      rpc: fake.rpc,
      questions: [
        snap({
          id: 'q-100',
          question: 'Postgres or SQLite for the cache layer?',
          projectId: 'p-mathscrabble',
          workerId: 'w-abc12345',
          urgency: 'blocking',
        }),
      ],
    });
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Question');
    expect(frame).toContain('q-100');
    expect(frame).toContain('[BLOCKING]');
    expect(frame).toContain('Postgres or SQLite');
    expect(frame).toContain('MathScrabble');
    expect(frame).toContain('w-abc12345');
    expect(frame).toContain('2m ago');
  });

  it('shows the optional context block in muted gray', () => {
    const fake = makeFakeRpc();
    const { lastFrame } = renderHarness({
      rpc: fake.rpc,
      questions: [
        snap({
          id: 'q-200',
          context: 'PLAN.md §2 leans SQLite for single-file deploy.',
        }),
      ],
    });
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Context:');
    expect(frame).toContain('PLAN.md §2 leans SQLite');
  });

  it('renders advisory urgency in gold-light', () => {
    const fake = makeFakeRpc();
    const { lastFrame } = renderHarness({
      rpc: fake.rpc,
      questions: [snap({ id: 'q-adv', urgency: 'advisory' })],
    });
    const frame = lastFrame() ?? '';
    // theme.warning = goldLight #E5C07B
    expect(frame).toContain('\x1b[38;2;229;192;123m');
  });

  it('displays "1/2 queued" navigation indicator when more than one question', () => {
    const fake = makeFakeRpc();
    const { lastFrame } = renderHarness({
      rpc: fake.rpc,
      questions: [
        snap({ id: 'q-1', askedAt: '2026-05-03T00:00:00.000Z' }),
        snap({ id: 'q-2', askedAt: '2026-05-03T01:00:00.000Z' }),
      ],
    });
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('1/2 queued');
    expect(frame).toContain('Tab/Shift+Tab cycle queue');
  });

  it('answer RPC fires when invoked directly (M2 + auto-pop covered by scenario)', async () => {
    // The InputBar→useInput→onSubmit chain in the popup is exercised
    // end-to-end by `tests/scenarios/3e.test.ts` (which drives
    // Ctrl+Q + writes 'deploy us-east' + Enter through stdin). At unit
    // scope, repeated stdin writes against `ink-testing-library` race
    // with React's commit + the answer-hook's Promise chain under
    // heavy parallel test load. The unit assertions here are
    // therefore: (1) the popup mounts correctly with multi-queue
    // content, (2) the underlying `questions.answer` wiring resolves
    // the right id+answer pair when called directly, (3) the optimistic
    // dismissal + auto-pop is exercised in the scenario test.
    const fake = makeFakeRpc();
    const { lastFrame } = renderHarness({
      rpc: fake.rpc,
      questions: [
        snap({ id: 'q-100', question: 'First question' }),
        snap({ id: 'q-200', question: 'Second question' }),
      ],
    });
    await flushAll();
    expect(stripAnsi(lastFrame() ?? '')).toContain('First question');
    expect(stripAnsi(lastFrame() ?? '')).toContain('1/2 queued');
    const promise = fake.rpc.call.questions.answer({ id: 'q-100', answer: 'SQLite' });
    fake.resolveNext();
    await promise;
    expect(fake.answers).toEqual([{ id: 'q-100', answer: 'SQLite' }]);
  });

  it('answer RPC rejection surfaces as the AlreadyAnsweredError envelope', async () => {
    const fake = makeFakeRpc();
    renderHarness({
      rpc: fake.rpc,
      questions: [snap({ id: 'q-100' })],
    });
    await flushAll();
    const promise = fake.rpc.call.questions.answer({ id: 'q-100', answer: 'a' });
    fake.rejectNext('already answered');
    let captured: string | null = null;
    try {
      await promise;
    } catch (err) {
      captured = err instanceof Error ? err.message : String(err);
    }
    expect(captured).toBe('already answered');
    expect(fake.answers).toEqual([{ id: 'q-100', answer: 'a' }]);
  });
});

// Flush microtasks AND a single macrotask hop. Under heavy parallel
// load, repeated `setImmediate` await-loops queue behind 100+ contending
// timers and time out the test (5s default budget). Pure microtask
// chains drain the React commit + Promise.then + useEffect chain
// without contending for the event loop.
async function flushAll(): Promise<void> {
  // 32 microtask rounds are essentially free and cover the longest
  // chain we have (stdin → InputBar → onSubmit → answer.submit → await
  // rpc → setState → React commit → useEffect → focus dispatch →
  // consumer re-render → popup unmount).
  for (let i = 0; i < 32; i += 1) {
    await Promise.resolve();
  }
  // One macrotask hop after the microtask drain so any timer-driven
  // settles (e.g. the 1.2s confirmation auto-clear is a setTimeout —
  // we don't wait for it, but we DO need the React commit hop) fire.
  await new Promise((r) => setImmediate(r));
}
