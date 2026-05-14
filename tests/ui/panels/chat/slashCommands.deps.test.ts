import { describe, it, expect, vi } from 'vitest';
import {
  buildSlashTable,
  dispatchSlash,
  parseSlashCommand,
} from '../../../../src/ui/panels/chat/slashCommands.js';

describe('slashCommands /deps (3P)', () => {
  it('parses /deps to command:deps', () => {
    expect(parseSlashCommand('/deps')).toEqual({ command: 'deps', rest: '' });
  });

  it('dispatches /deps to openDeps handler', () => {
    const openDeps = vi.fn();
    const table = buildSlashTable({ quit: vi.fn(), openDeps });
    expect(dispatchSlash('/deps', table)).toBe('dispatched');
    expect(openDeps).toHaveBeenCalledOnce();
  });

  it('without openDeps handler the /deps entry is not registered', () => {
    // Same 3H.1 M2 pattern: silent no-op was the prior failure mode.
    // Now the slash returns 'unknown' so the chat surfaces an inline
    // error rather than swallowing.
    const table = buildSlashTable({ quit: vi.fn() });
    expect(dispatchSlash('/deps', table)).toBe('unknown');
  });

  it('coexists with /stats / /config / /away / /quit', () => {
    const quit = vi.fn();
    const openSettings = vi.fn();
    const toggleAway = vi.fn();
    const openStats = vi.fn();
    const openDeps = vi.fn();
    const table = buildSlashTable({ quit, openSettings, toggleAway, openStats, openDeps });
    expect(dispatchSlash('/quit', table)).toBe('dispatched');
    expect(dispatchSlash('/config', table)).toBe('dispatched');
    expect(dispatchSlash('/away', table)).toBe('dispatched');
    expect(dispatchSlash('/stats', table)).toBe('dispatched');
    expect(dispatchSlash('/deps', table)).toBe('dispatched');
    expect(quit).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledOnce();
    expect(toggleAway).toHaveBeenCalledOnce();
    expect(openStats).toHaveBeenCalledOnce();
    expect(openDeps).toHaveBeenCalledOnce();
  });
});
