import { describe, it, expect, vi } from 'vitest';
import {
  buildSlashTable,
  dispatchSlash,
  parseSlashCommand,
} from '../../../../src/ui/panels/chat/slashCommands.js';

describe('slashCommands /config (3H.1)', () => {
  it('parses /config to command:config', () => {
    const result = parseSlashCommand('/config');
    expect(result).toEqual({ command: 'config', rest: '' });
  });

  it('dispatches /config to openSettings handler', () => {
    const openSettings = vi.fn();
    const table = buildSlashTable({ quit: vi.fn(), openSettings });
    const outcome = dispatchSlash('/config', table);
    expect(outcome).toBe('dispatched');
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('without openSettings handler the /config entry is not registered, so it returns "unknown"', () => {
    // 3H.1 audit M2: silent dispatch with no handler was the previous
    // failure mode — keystrokes vanished without surfacing an error.
    // Now buildSlashTable omits the `config` entry entirely when the
    // handler is undefined, so dispatchSlash returns 'unknown' and the
    // chat panel renders "Unknown command: config" inline.
    const table = buildSlashTable({ quit: vi.fn() });
    const outcome = dispatchSlash('/config', table);
    expect(outcome).toBe('unknown');
  });

  it('coexists with /quit', () => {
    const quit = vi.fn();
    const openSettings = vi.fn();
    const table = buildSlashTable({ quit, openSettings });
    expect(dispatchSlash('/quit', table)).toBe('dispatched');
    expect(dispatchSlash('/config', table)).toBe('dispatched');
    expect(quit).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledOnce();
  });
});
