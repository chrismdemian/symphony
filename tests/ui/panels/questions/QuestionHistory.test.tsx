import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../../../src/ui/keybinds/dispatcher.js';
import { QuestionHistory } from '../../../../src/ui/panels/questions/QuestionHistory.js';
import type { TuiRpc } from '../../../../src/ui/runtime/rpc.js';
import type { QuestionSnapshot } from '../../../../src/state/question-registry.js';
import type { ProjectSnapshot } from '../../../../src/projects/types.js';

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');

const PROJECTS: readonly ProjectSnapshot[] = [
  {
    id: 'p-mathscrabble',
    name: 'MathScrabble',
    path: 'C:/foo',
    createdAt: '2026-04-29T00:00:00.000Z',
  },
];

function makeFakeRpc(answered: readonly QuestionSnapshot[]): TuiRpc {
  const stub = (): unknown => vi.fn();
  return {
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
        list: vi.fn(async (filter?: { answered?: boolean }) => {
          if (filter?.answered === true) return [...answered];
          return [];
        }) as never,
        get: stub() as never,
        answer: stub() as never,
      },
      waves: { list: stub() as never, get: stub() as never },
      mode: { get: stub() as never },
    },
    subscribe: vi.fn(),
    close: vi.fn(),
  } as unknown as TuiRpc;
}

const HISTORY: readonly QuestionSnapshot[] = [
  {
    id: 'q-old',
    question: 'Postgres or SQLite?',
    urgency: 'blocking',
    askedAt: '2026-05-03T00:00:00.000Z',
    answered: true,
    answer: 'sqlite',
    answeredAt: '2026-05-03T00:01:00.000Z',
    projectId: 'p-mathscrabble',
  },
  {
    id: 'q-new',
    question: 'Branch naming?',
    urgency: 'advisory',
    askedAt: '2026-05-03T01:00:00.000Z',
    answered: true,
    answer: 'feature/',
    answeredAt: '2026-05-03T01:01:00.000Z',
    projectId: 'p-mathscrabble',
  },
];

function renderHarness(answered: readonly QuestionSnapshot[]) {
  const initial: FocusState = {
    stack: [
      { kind: 'main', key: 'chat' },
      { kind: 'popup', key: 'question-history' },
    ],
  };
  const rpc = makeFakeRpc(answered);
  return render(
    <ThemeProvider>
      <FocusProvider initial={initial}>
        <KeybindProvider initialCommands={[]}>
          <QuestionHistory rpc={rpc} projects={PROJECTS} />
        </KeybindProvider>
      </FocusProvider>
    </ThemeProvider>,
  );
}

describe('<QuestionHistory>', () => {
  it('renders header + count once questions load', async () => {
    const { lastFrame } = renderHarness(HISTORY);
    await new Promise((r) => setTimeout(r, 60));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Answered questions');
    expect(frame).toContain('· 2');
  });

  it('shows newest answered first (sort by answeredAt desc)', async () => {
    const { lastFrame } = renderHarness(HISTORY);
    await new Promise((r) => setTimeout(r, 60));
    const frame = stripAnsi(lastFrame() ?? '');
    const branchIdx = frame.indexOf('Branch naming');
    const cacheIdx = frame.indexOf('Postgres or SQLite');
    expect(branchIdx).toBeGreaterThan(-1);
    expect(cacheIdx).toBeGreaterThan(-1);
    expect(branchIdx).toBeLessThan(cacheIdx);
  });

  it('renders question + answer + project name', async () => {
    const { lastFrame } = renderHarness(HISTORY);
    await new Promise((r) => setTimeout(r, 60));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Q: Branch naming?');
    expect(frame).toContain('A: feature/');
    expect(frame).toContain('MathScrabble');
  });

  it('shows empty state when no answered questions', async () => {
    const { lastFrame } = renderHarness([]);
    await new Promise((r) => setTimeout(r, 60));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('(no answered questions yet)');
  });

  it('renders the Esc/↑↓ footer hint', async () => {
    const { lastFrame } = renderHarness(HISTORY);
    await new Promise((r) => setTimeout(r, 60));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Esc to close');
    expect(frame).toContain('↑↓');
  });
});
