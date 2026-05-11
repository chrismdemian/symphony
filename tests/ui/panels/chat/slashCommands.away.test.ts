import { describe, it, expect, vi } from 'vitest';
import {
  buildSlashTable,
  dispatchSlash,
  parseSlashCommand,
} from '../../../../src/ui/panels/chat/slashCommands.js';

/**
 * Phase 3M — `/away` slash command toggles `config.awayMode`. Mirrors
 * the 3H.1 `/config` test shape: parsed name + handler dispatch + the
 * "unknown when handler omitted" guard (3H.1 audit M2 pattern — silent
 * dispatch was the previous failure mode).
 */
describe('slashCommands /away (3M)', () => {
  it('parses /away to command:away', () => {
    const result = parseSlashCommand('/away');
    expect(result).toEqual({ command: 'away', rest: '' });
  });

  it('parses /AWAY case-insensitively', () => {
    const result = parseSlashCommand('/AWAY');
    expect(result).toEqual({ command: 'away', rest: '' });
  });

  it('dispatches /away to toggleAway handler', () => {
    const toggleAway = vi.fn();
    const table = buildSlashTable({ quit: vi.fn(), toggleAway });
    const outcome = dispatchSlash('/away', table);
    expect(outcome).toBe('dispatched');
    expect(toggleAway).toHaveBeenCalledOnce();
  });

  it('without toggleAway handler the /away entry is not registered, so it returns "unknown"', () => {
    const table = buildSlashTable({ quit: vi.fn() });
    const outcome = dispatchSlash('/away', table);
    expect(outcome).toBe('unknown');
  });

  it('coexists with /quit and /config', () => {
    const quit = vi.fn();
    const openSettings = vi.fn();
    const toggleAway = vi.fn();
    const table = buildSlashTable({ quit, openSettings, toggleAway });
    expect(dispatchSlash('/quit', table)).toBe('dispatched');
    expect(dispatchSlash('/config', table)).toBe('dispatched');
    expect(dispatchSlash('/away', table)).toBe('dispatched');
    expect(quit).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledOnce();
    expect(toggleAway).toHaveBeenCalledOnce();
  });
});
