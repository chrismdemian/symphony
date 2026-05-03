import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import {
  WorkerSelectionProvider,
  useWorkerSelection,
  type WorkerSelectionController,
} from '../../../src/ui/data/WorkerSelection.js';

interface ProbeProps {
  readonly onMount: (controller: WorkerSelectionController) => void;
}

function Probe({ onMount }: ProbeProps): React.JSX.Element {
  const controller = useWorkerSelection();
  onMount(controller);
  return <Text>{controller.selectedId ?? '<none>'}</Text>;
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function mount(initial?: string | null): {
  controllerRef: { current: WorkerSelectionController | null };
  lastFrame: () => string | undefined;
} {
  const controllerRef: { current: WorkerSelectionController | null } = { current: null };
  const captured = (c: WorkerSelectionController): void => {
    controllerRef.current = c;
  };
  const tree =
    initial === undefined ? (
      <WorkerSelectionProvider>
        <Probe onMount={captured} />
      </WorkerSelectionProvider>
    ) : (
      <WorkerSelectionProvider initialSelectedId={initial}>
        <Probe onMount={captured} />
      </WorkerSelectionProvider>
    );
  const r = render(tree);
  return { controllerRef, lastFrame: r.lastFrame };
}

describe('WorkerSelectionProvider', () => {
  it('starts with null selection by default', () => {
    const { lastFrame } = mount();
    expect(lastFrame()).toContain('<none>');
  });

  it('honors initialSelectedId', () => {
    const { lastFrame } = mount('w1');
    expect(lastFrame()).toContain('w1');
  });

  it('setSelectedId updates the selection', async () => {
    const { controllerRef, lastFrame } = mount();
    controllerRef.current!.setSelectedId('w7');
    await flush();
    expect(lastFrame()).toContain('w7');
  });

  it('reconcile selects the first id when nothing is selected', async () => {
    const { controllerRef, lastFrame } = mount();
    controllerRef.current!.reconcile(['a', 'b']);
    await flush();
    expect(lastFrame()).toContain('a');
  });

  it('reconcile keeps the current selection when still visible', async () => {
    const { controllerRef, lastFrame } = mount('b');
    controllerRef.current!.reconcile(['a', 'b', 'c']);
    await flush();
    expect(lastFrame()).toContain('b');
  });

  it('reconcile falls back to first id when current selection drops out', async () => {
    const { controllerRef, lastFrame } = mount('b');
    controllerRef.current!.reconcile(['a', 'c']);
    await flush();
    expect(lastFrame()).toContain('a');
  });

  it('reconcile clears selection when list is empty', async () => {
    const { controllerRef, lastFrame } = mount('a');
    controllerRef.current!.reconcile([]);
    await flush();
    expect(lastFrame()).toContain('<none>');
  });

  it('cycleNext advances and wraps', async () => {
    const { controllerRef, lastFrame } = mount('a');
    const ids = ['a', 'b', 'c'];
    controllerRef.current!.cycleNext(ids);
    await flush();
    expect(lastFrame()).toContain('b');
    controllerRef.current!.cycleNext(ids);
    await flush();
    expect(lastFrame()).toContain('c');
    controllerRef.current!.cycleNext(ids);
    await flush();
    expect(lastFrame()).toContain('a');
  });

  it('cyclePrev moves backward and wraps', async () => {
    const { controllerRef, lastFrame } = mount('a');
    const ids = ['a', 'b', 'c'];
    controllerRef.current!.cyclePrev(ids);
    await flush();
    expect(lastFrame()).toContain('c');
    controllerRef.current!.cyclePrev(ids);
    await flush();
    expect(lastFrame()).toContain('b');
  });

  it('selectByOrdinal honors 1-indexed selection within bounds', async () => {
    const { controllerRef, lastFrame } = mount();
    const ids = ['a', 'b', 'c'];
    controllerRef.current!.selectByOrdinal(ids, 2);
    await flush();
    expect(lastFrame()).toContain('b');
  });

  it('selectByOrdinal ignores out-of-range and zero/negative input', async () => {
    const { controllerRef, lastFrame } = mount('a');
    const ids = ['a', 'b'];
    controllerRef.current!.selectByOrdinal(ids, 0);
    await flush();
    expect(lastFrame()).toContain('a');
    controllerRef.current!.selectByOrdinal(ids, -1);
    await flush();
    expect(lastFrame()).toContain('a');
    controllerRef.current!.selectByOrdinal(ids, 9);
    await flush();
    expect(lastFrame()).toContain('a');
  });

  it('cycleNext handles unknown current selection by jumping to first', async () => {
    const { controllerRef, lastFrame } = mount('zzz-stale');
    controllerRef.current!.cycleNext(['a', 'b']);
    await flush();
    expect(lastFrame()).toContain('a');
  });
});
