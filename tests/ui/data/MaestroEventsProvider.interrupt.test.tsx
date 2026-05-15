import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import {
  MaestroEventsProvider,
  useMaestroData,
  type MaestroController,
} from '../../../src/ui/data/MaestroEventsProvider.js';
import {
  MaestroTurnInFlightError,
  type MaestroEvent,
} from '../../../src/orchestrator/maestro/process.js';

// ink-testing-library + React 19 useState batches into the next render
// pass; observers must flush microtasks before re-reading captureRef.
async function settle(): Promise<void> {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Phase 3T — MaestroEventsProvider interrupt-envelope behavior.
 *
 *   1. markInterrupted() arms the envelope; the next sendUserMessage
 *      wraps the outgoing text with `[INTERRUPT NOTICE]` and clears the
 *      flag.
 *   2. Subsequent sendUserMessage calls do NOT wrap (flag stays false).
 *   3. The synthetic chat row is pushed with statusKind='interrupted'.
 */

function makeFakeSource(): MaestroController & { sendCalls: string[] } {
  const sendCalls: string[] = [];
  return {
    events: async function* () {
      // Never yields — interrupt tests don't need MaestroEvent input.
    } as () => AsyncIterable<MaestroEvent>,
    sendUserMessage: (text: string) => {
      sendCalls.push(text);
    },
    sendCalls,
  };
}

function Harness({
  captureRef,
}: {
  readonly captureRef: { current?: ReturnType<typeof useMaestroData> };
}): React.JSX.Element {
  const data = useMaestroData();
  captureRef.current = data;
  return <Text>turns: {data.turns.length}</Text>;
}

describe('MaestroEventsProvider — interrupt envelope (3T)', () => {
  it('wraps the next sendUserMessage with [INTERRUPT NOTICE] after markInterrupted', async () => {
    const source = makeFakeSource();
    const captureRef: { current?: ReturnType<typeof useMaestroData> } = {};
    render(
      <MaestroEventsProvider source={source} now={() => 1_000_000}>
        <Harness captureRef={captureRef} />
      </MaestroEventsProvider>,
    );

    await settle();
    expect(captureRef.current!.interruptPending).toBe(false);

    captureRef.current!.markInterrupted({
      workersKilled: ['w-1', 'w-2'],
      queuedCancelled: [],
      tasksCancelled: ['t-3'],
    });
    await settle();

    expect(captureRef.current!.interruptPending).toBe(true);
    expect(captureRef.current!.turns.length).toBe(1);
    const systemTurn = captureRef.current!.turns[0];
    expect(systemTurn?.kind).toBe('system');
    if (systemTurn?.kind === 'system') {
      expect(systemTurn.summary.statusKind).toBe('interrupted');
      expect(systemTurn.summary.headline).toContain('2 workers killed');
      expect(systemTurn.summary.headline).toContain('1 pending task');
    }

    captureRef.current!.sendUserMessage('redo with new direction');
    await settle();
    expect(source.sendCalls).toHaveLength(1);
    expect(source.sendCalls[0]).toContain('[INTERRUPT NOTICE]');
    expect(source.sendCalls[0]).toMatch(/redo with new direction$/);
    expect(captureRef.current!.interruptPending).toBe(false);

    captureRef.current!.sendUserMessage('another message');
    await settle();
    expect(source.sendCalls).toHaveLength(2);
    expect(source.sendCalls[1]).toBe('another message');
    expect(source.sendCalls[1]).not.toContain('INTERRUPT NOTICE');
  });

  it('headline degrades gracefully when nothing was in flight', async () => {
    const source = makeFakeSource();
    const captureRef: { current?: ReturnType<typeof useMaestroData> } = {};
    render(
      <MaestroEventsProvider source={source} now={() => 1}>
        <Harness captureRef={captureRef} />
      </MaestroEventsProvider>,
    );

    await settle();
    captureRef.current!.markInterrupted({
      workersKilled: [],
      queuedCancelled: [],
      tasksCancelled: [],
    });
    await settle();

    const turn = captureRef.current!.turns[0];
    if (turn?.kind === 'system') {
      expect(turn.summary.headline).toContain('nothing in flight');
      expect(turn.summary.headline).toContain('Awaiting new direction');
    } else {
      throw new Error('expected a system turn');
    }
  });

  it('pluralization is correct (single vs multiple)', async () => {
    const source = makeFakeSource();
    const captureRef: { current?: ReturnType<typeof useMaestroData> } = {};
    render(
      <MaestroEventsProvider source={source} now={() => 1}>
        <Harness captureRef={captureRef} />
      </MaestroEventsProvider>,
    );

    await settle();
    captureRef.current!.markInterrupted({
      workersKilled: ['only-one'],
      queuedCancelled: ['q-1'],
      tasksCancelled: [],
    });
    await settle();

    const turn = captureRef.current!.turns[0];
    if (turn?.kind === 'system') {
      expect(turn.summary.headline).toContain('1 worker killed');
      expect(turn.summary.headline).not.toContain('1 workers');
      expect(turn.summary.headline).toContain('1 queued spawn drained');
      expect(turn.summary.headline).not.toContain('1 queued spawns');
    }
  });

  it('a turn_in_flight rejection from Maestro leaves the envelope flag armed', async () => {
    const source: MaestroController = {
      events: async function* () {} as () => AsyncIterable<MaestroEvent>,
      sendUserMessage: () => {
        throw new MaestroTurnInFlightError();
      },
    };
    const captureRef: { current?: ReturnType<typeof useMaestroData> } = {};
    render(
      <MaestroEventsProvider source={source} now={() => 1}>
        <Harness captureRef={captureRef} />
      </MaestroEventsProvider>,
    );

    await settle();
    captureRef.current!.markInterrupted({
      workersKilled: ['w-1'],
      queuedCancelled: [],
      tasksCancelled: [],
    });
    await settle();
    expect(captureRef.current!.interruptPending).toBe(true);

    const result = captureRef.current!.sendUserMessage('hello');
    await settle();
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe('turn_in_flight');

    // Flag REMAINS armed so the next retry still wraps.
    expect(captureRef.current!.interruptPending).toBe(true);
  });
});
