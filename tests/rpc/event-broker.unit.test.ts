import { describe, expect, it, vi } from 'vitest';
import { WorkerEventBroker } from '../../src/rpc/event-broker.js';
import type { StreamEvent } from '../../src/workers/types.js';

function textEvent(text: string): StreamEvent {
  return { type: 'assistant_text', text };
}

describe('rpc/event-broker', () => {
  it('subscribe returns an unsubscribe function', () => {
    const broker = new WorkerEventBroker();
    const listener = vi.fn();
    const unsub = broker.subscribe('wk-1', listener);
    expect(typeof unsub).toBe('function');
    expect(broker.subscriberCount('wk-1')).toBe(1);
  });

  it('publish fans out to every subscriber for the worker', () => {
    const broker = new WorkerEventBroker();
    const a = vi.fn();
    const b = vi.fn();
    broker.subscribe('wk-1', a);
    broker.subscribe('wk-1', b);
    broker.publish('wk-1', textEvent('hi'));
    expect(a).toHaveBeenCalledWith(textEvent('hi'));
    expect(b).toHaveBeenCalledWith(textEvent('hi'));
  });

  it('publish does not deliver to subscribers of other workers', () => {
    const broker = new WorkerEventBroker();
    const a = vi.fn();
    const b = vi.fn();
    broker.subscribe('wk-1', a);
    broker.subscribe('wk-2', b);
    broker.publish('wk-1', textEvent('hi'));
    expect(a).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
  });

  it('publish on a worker with no subscribers is a no-op', () => {
    const broker = new WorkerEventBroker();
    expect(() => broker.publish('wk-empty', textEvent('hi'))).not.toThrow();
  });

  it('unsubscribe removes the listener; further publishes do not reach it', () => {
    const broker = new WorkerEventBroker();
    const a = vi.fn();
    const unsub = broker.subscribe('wk-1', a);
    unsub();
    broker.publish('wk-1', textEvent('hi'));
    expect(a).not.toHaveBeenCalled();
  });

  it('drops the worker entry once the last subscriber leaves', () => {
    const broker = new WorkerEventBroker();
    const unsub = broker.subscribe('wk-1', vi.fn());
    expect(broker.workerCount()).toBe(1);
    unsub();
    expect(broker.workerCount()).toBe(0);
    expect(broker.hasSubscribers('wk-1')).toBe(false);
  });

  it('faulty listener does not poison fan-out for siblings', () => {
    const broker = new WorkerEventBroker();
    const evil = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    broker.subscribe('wk-1', evil);
    broker.subscribe('wk-1', good);
    expect(() => broker.publish('wk-1', textEvent('hi'))).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it('allows a listener to unsubscribe during fan-out without skipping siblings', () => {
    const broker = new WorkerEventBroker();
    const holder: { unsub2?: () => void } = {};
    const a = vi.fn(() => {
      // Listener-during-fanout cleanup must not throw or skip the next listener.
      holder.unsub2!();
    });
    const b = vi.fn();
    broker.subscribe('wk-1', a);
    holder.unsub2 = broker.subscribe('wk-1', b);
    broker.publish('wk-1', textEvent('hi'));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('clear drops every subscriber across every worker', () => {
    const broker = new WorkerEventBroker();
    broker.subscribe('wk-1', vi.fn());
    broker.subscribe('wk-2', vi.fn());
    expect(broker.workerCount()).toBe(2);
    broker.clear();
    expect(broker.workerCount()).toBe(0);
  });

  it('repeated subscribes for the same listener instance count once (Set semantics)', () => {
    const broker = new WorkerEventBroker();
    const listener = vi.fn();
    broker.subscribe('wk-1', listener);
    broker.subscribe('wk-1', listener);
    expect(broker.subscriberCount('wk-1')).toBe(1);
    broker.publish('wk-1', textEvent('hi'));
    expect(listener).toHaveBeenCalledOnce();
  });
});
