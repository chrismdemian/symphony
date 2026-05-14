import { describe, expect, it } from 'vitest';
import {
  createTaskReadyBroker,
  TaskReadyBrokerImpl,
} from '../../src/orchestrator/task-ready-broker.js';
import type { TaskReadyEvent } from '../../src/orchestrator/task-ready-types.js';

/**
 * Phase 3P — broker mirrors `AutoMergeBrokerImpl`. Same contract:
 *   - subscribe returns unsubscribe
 *   - publish fans out to every subscriber
 *   - snapshot-then-iterate so mid-publish removals don't drop siblings
 *   - listener throws are swallowed
 *   - clear drops every subscriber
 *
 * No replay buffer — late subscribers do not see prior events.
 */

const ISO = '2026-04-23T00:00:00.000Z';

function makeEvent(id = 'tk-1'): TaskReadyEvent {
  return {
    kind: 'task_ready',
    task: {
      id,
      projectId: 'p1',
      description: 'task ' + id,
      status: 'pending',
      priority: 0,
      dependsOn: [],
      notes: [],
      createdAt: ISO,
      updatedAt: ISO,
    },
    projectName: 'p1',
    unblockedBy: {
      id: 'tk-prev',
      projectId: 'p1',
      description: 'previous',
      status: 'completed',
      priority: 0,
      dependsOn: [],
      notes: [],
      createdAt: ISO,
      updatedAt: ISO,
      completedAt: ISO,
    },
    unblockedByProjectName: 'p1',
    headline: 'Task ready: task ' + id + ' (p1) — previous completed',
    ts: ISO,
  };
}

describe('TaskReadyBroker', () => {
  it('fans out to every subscriber', () => {
    const broker = new TaskReadyBrokerImpl();
    const seenA: TaskReadyEvent[] = [];
    const seenB: TaskReadyEvent[] = [];
    broker.subscribe((e) => seenA.push(e));
    broker.subscribe((e) => seenB.push(e));
    const evt = makeEvent();
    broker.publish(evt);
    expect(seenA).toEqual([evt]);
    expect(seenB).toEqual([evt]);
  });

  it('unsubscribe stops further delivery', () => {
    const broker = new TaskReadyBrokerImpl();
    const seen: TaskReadyEvent[] = [];
    const unsub = broker.subscribe((e) => seen.push(e));
    broker.publish(makeEvent('a'));
    unsub();
    broker.publish(makeEvent('b'));
    expect(seen.map((e) => e.task.id)).toEqual(['a']);
  });

  it('mid-publish unsubscribe does not skip sibling listeners (snapshot-then-iterate)', () => {
    const broker = new TaskReadyBrokerImpl();
    const seenA: TaskReadyEvent[] = [];
    const seenB: TaskReadyEvent[] = [];
    const unsubA = broker.subscribe((e) => {
      seenA.push(e);
      unsubA();
    });
    broker.subscribe((e) => seenB.push(e));
    broker.publish(makeEvent());
    expect(seenA).toHaveLength(1);
    // B still receives the event despite A removing itself first.
    expect(seenB).toHaveLength(1);
  });

  it('a faulty listener does not poison sibling listeners', () => {
    const broker = new TaskReadyBrokerImpl();
    const seen: TaskReadyEvent[] = [];
    broker.subscribe(() => {
      throw new Error('boom');
    });
    broker.subscribe((e) => seen.push(e));
    expect(() => broker.publish(makeEvent())).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('clear drops every subscriber', () => {
    const broker = new TaskReadyBrokerImpl();
    const seen: TaskReadyEvent[] = [];
    broker.subscribe((e) => seen.push(e));
    expect(broker.subscriberCount()).toBe(1);
    broker.clear();
    expect(broker.subscriberCount()).toBe(0);
    broker.publish(makeEvent());
    expect(seen).toEqual([]);
  });

  it('publish with zero subscribers is a no-op (fast path)', () => {
    const broker = new TaskReadyBrokerImpl();
    expect(() => broker.publish(makeEvent())).not.toThrow();
  });

  it('createTaskReadyBroker returns a working impl', () => {
    const broker = createTaskReadyBroker();
    const seen: TaskReadyEvent[] = [];
    broker.subscribe((e) => seen.push(e));
    broker.publish(makeEvent());
    expect(seen).toHaveLength(1);
  });
});
