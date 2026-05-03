import { describe, expect, it } from 'vitest';
import { INSTRUMENT_POOL, allocateInstruments } from '../../../src/ui/data/instruments.js';

describe('allocateInstruments', () => {
  it('returns empty for empty input', () => {
    const result = allocateInstruments([], new Map());
    expect(result.size).toBe(0);
  });

  it('assigns the first pool slot to the first id', () => {
    const result = allocateInstruments(['w1'], new Map());
    expect(result.get('w1')).toBe(INSTRUMENT_POOL[0]);
  });

  it('assigns distinct names in id-order', () => {
    const result = allocateInstruments(['a', 'b', 'c'], new Map());
    expect(result.get('a')).toBe(INSTRUMENT_POOL[0]);
    expect(result.get('b')).toBe(INSTRUMENT_POOL[1]);
    expect(result.get('c')).toBe(INSTRUMENT_POOL[2]);
  });

  it('preserves a name when the id stays in the set', () => {
    const first = allocateInstruments(['a', 'b'], new Map());
    const second = allocateInstruments(['a', 'b'], first);
    expect(second.get('a')).toBe(first.get('a'));
    expect(second.get('b')).toBe(first.get('b'));
  });

  it('returns a dropped name to the pool', () => {
    const first = allocateInstruments(['a', 'b'], new Map());
    const droppedName = first.get('a');
    const second = allocateInstruments(['b', 'c'], first);
    expect(second.get('b')).toBe(first.get('b'));
    expect(second.get('c')).toBe(droppedName);
  });

  it('does not collide a re-added id with a still-living one', () => {
    const a = allocateInstruments(['a'], new Map());
    const ab = allocateInstruments(['a', 'b'], a);
    const aOnly = allocateInstruments(['a'], ab);
    const aAgain = allocateInstruments(['a', 'b'], aOnly);
    expect(aAgain.get('a')).toBe(a.get('a'));
    // 'b' was reaped between aOnly and aAgain → its slot was free; it
    // now gets the lowest free slot, which is the second pool entry.
    expect(aAgain.get('b')).toBe(INSTRUMENT_POOL[1]);
  });

  it('falls back to Worker-N once the pool is exhausted', () => {
    const ids = Array.from({ length: INSTRUMENT_POOL.length + 2 }, (_, i) => `w${i}`);
    const result = allocateInstruments(ids, new Map());
    const overflow = ids
      .slice(INSTRUMENT_POOL.length)
      .map((id) => result.get(id));
    expect(overflow).toEqual(['Worker-1', 'Worker-2']);
  });

  it('does not double-assign when previous holds an out-of-pool name', () => {
    const previous = new Map<string, string>([['a', 'Worker-1']]);
    const result = allocateInstruments(['a', 'b'], previous);
    expect(result.get('a')).toBe('Worker-1');
    // 'b' must NOT also be Worker-1 — the previous mapping is taken.
    expect(result.get('b')).toBe(INSTRUMENT_POOL[0]);
  });
});
