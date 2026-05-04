import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { FocusProvider, type FocusState } from '../../../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../../../src/ui/keybinds/dispatcher.js';
import { WorkerSelectionProvider, useWorkerSelection } from '../../../../src/ui/data/WorkerSelection.js';
import { WorkerSelector } from '../../../../src/ui/panels/palette/WorkerSelector.js';
import type { WorkerRecordSnapshot } from '../../../../src/orchestrator/worker-registry.js';

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');

function snap(over: Partial<WorkerRecordSnapshot>): WorkerRecordSnapshot {
  return {
    id: over.id ?? 'w-aaa',
    projectPath: '/repos/demo',
    worktreePath: '/repos/demo/.symphony/worktrees/w-aaa',
    role: 'implementer',
    featureIntent: 'frontend redesign',
    taskDescription: 'task',
    autonomyTier: 1,
    dependsOn: [],
    status: 'running',
    createdAt: '2026-05-04T00:00:00.000Z',
    ...over,
  } as WorkerRecordSnapshot;
}

function renderHarness(workers: readonly WorkerRecordSnapshot[]) {
  const initial: FocusState = {
    stack: [
      { kind: 'main', key: 'chat' },
      { kind: 'popup', key: 'worker-select' },
    ],
  };
  let selectionRef: ReturnType<typeof useWorkerSelection> | null = null;
  function Capture(): null {
    selectionRef = useWorkerSelection();
    return null;
  }
  const result = render(
    <ThemeProvider>
      <FocusProvider initial={initial}>
        <WorkerSelectionProvider>
          <KeybindProvider initialCommands={[]}>
            <Capture />
            <WorkerSelector workers={workers} />
          </KeybindProvider>
        </WorkerSelectionProvider>
      </FocusProvider>
    </ThemeProvider>,
  );
  return { ...result, getSelection: () => selectionRef };
}

describe('<WorkerSelector>', () => {
  it('renders all workers when filter is empty', () => {
    const workers = [
      snap({ id: 'w-1', featureIntent: 'frontend redesign' }),
      snap({ id: 'w-2', featureIntent: 'api refactor' }),
      snap({ id: 'w-3', featureIntent: 'ci pipeline fix' }),
    ];
    const { lastFrame } = renderHarness(workers);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Select worker');
    expect(frame).toContain('3 of 3');
    expect(frame).toContain('frontend redesign');
    expect(frame).toContain('api refactor');
    expect(frame).toContain('ci pipeline fix');
  });

  it('typing filters by feature intent', async () => {
    const workers = [
      snap({ id: 'w-1', featureIntent: 'frontend redesign' }),
      snap({ id: 'w-2', featureIntent: 'api refactor' }),
    ];
    const { stdin, lastFrame } = renderHarness(workers);
    stdin.write('api');
    await new Promise((r) => setTimeout(r, 60));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('api refactor');
    expect(frame).not.toContain('frontend redesign');
  });

  it('Enter selects the worker via WorkerSelectionProvider', async () => {
    const workers = [snap({ id: 'w-target', featureIntent: 'target work' })];
    const { stdin, getSelection } = renderHarness(workers);
    expect(getSelection()?.selectedId).toBe(null);
    // Wait for popup-scope command registration to flush.
    await new Promise((r) => setTimeout(r, 80));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 100));
    expect(getSelection()?.selectedId).toBe('w-target');
  });

  it('shows "(no workers match)" when nothing matches', async () => {
    const workers = [snap({ id: 'w-1', featureIntent: 'alpha' })];
    const { stdin, lastFrame } = renderHarness(workers);
    stdin.write('zzzz');
    await new Promise((r) => setTimeout(r, 60));
    expect(stripAnsi(lastFrame() ?? '')).toContain('(no workers match)');
  });
});
