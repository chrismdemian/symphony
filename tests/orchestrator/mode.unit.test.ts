import { describe, expect, it } from 'vitest';
import { ModeController } from '../../src/orchestrator/mode.js';
import type { ModeChangeEvent } from '../../src/orchestrator/mode.js';

describe('ModeController', () => {
  it('defaults to plan mode', () => {
    const m = new ModeController();
    expect(m.mode).toBe('plan');
  });

  it('honors initial override', () => {
    const m = new ModeController({ initial: 'act' });
    expect(m.mode).toBe('act');
  });

  it('setMode(same) is a no-op and returns false', () => {
    const m = new ModeController();
    const events: ModeChangeEvent[] = [];
    m.onChange((e) => events.push(e));
    expect(m.setMode('plan', 'noop')).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('setMode(different) fires a change event with previous/next/reason', () => {
    const m = new ModeController();
    const events: ModeChangeEvent[] = [];
    m.onChange((e) => events.push(e));
    expect(m.setMode('act', 'user approved plan')).toBe(true);
    expect(m.mode).toBe('act');
    expect(events).toEqual([{ previous: 'plan', next: 'act', reason: 'user approved plan' }]);
  });

  it('unsubscribe removes the listener', () => {
    const m = new ModeController();
    const events: ModeChangeEvent[] = [];
    const off = m.onChange((e) => events.push(e));
    off();
    m.setMode('act', '');
    expect(events).toHaveLength(0);
  });

  it('fires one event per transition, not a duplicate when reverting', () => {
    const m = new ModeController();
    const events: ModeChangeEvent[] = [];
    m.onChange((e) => events.push(e));
    m.setMode('act', 'go');
    m.setMode('plan', 'back');
    expect(events.map((e) => e.next)).toEqual(['act', 'plan']);
  });

  it('permits multiple subscribers', () => {
    const m = new ModeController();
    const a: ModeChangeEvent[] = [];
    const b: ModeChangeEvent[] = [];
    m.onChange((e) => a.push(e));
    m.onChange((e) => b.push(e));
    m.setMode('act', '');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('defaults empty reason to empty string', () => {
    const m = new ModeController();
    let seen: ModeChangeEvent | null = null;
    m.onChange((e) => (seen = e));
    m.setMode('act');
    expect(seen).toEqual({ previous: 'plan', next: 'act', reason: '' });
  });
});
