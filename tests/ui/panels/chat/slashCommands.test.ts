import { describe, it, expect, vi } from 'vitest';
import {
  buildSlashTable,
  dispatchSlash,
  parseSlashCommand,
} from '../../../../src/ui/panels/chat/slashCommands.js';

describe('parseSlashCommand', () => {
  it('parses a bare /quit', () => {
    expect(parseSlashCommand('/quit')).toEqual({ command: 'quit', rest: '' });
  });

  it('lowercases the command name', () => {
    expect(parseSlashCommand('/QUIT')).toEqual({ command: 'quit', rest: '' });
  });

  it('captures rest after the command', () => {
    expect(parseSlashCommand('/w violin')).toEqual({ command: 'w', rest: 'violin' });
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseSlashCommand('   /quit   ')).toEqual({ command: 'quit', rest: '' });
  });

  it('returns null for plain text without a leading slash', () => {
    expect(parseSlashCommand('quit')).toBeNull();
    expect(parseSlashCommand('hello /quit')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseSlashCommand('')).toBeNull();
    expect(parseSlashCommand('   ')).toBeNull();
  });

  it('returns null for multi-line input even if line 1 looks like a command', () => {
    // Multi-line is ALWAYS a literal message — the user used Ctrl+J or
    // Shift+Enter and meant to send the whole thing.
    expect(parseSlashCommand('/quit\nthen do X')).toBeNull();
  });

  it('returns null for /<digits> (regex requires alpha)', () => {
    expect(parseSlashCommand('/123')).toBeNull();
  });

  it('rejects /<alpha>NNN — no word boundary between alpha and digit', () => {
    // The `\b` anchor in the regex requires a non-word character to
    // follow the command name. `foo123` is one word; we'd rather reject
    // it cleanly than accept `foo` and stuff `123` into rest. If a
    // future command needs digit args, callers separate with whitespace
    // (`/w1` is not a valid command name in 3B.2 either).
    expect(parseSlashCommand('/foo123')).toBeNull();
  });

  it('treats lone slash as not-a-command', () => {
    expect(parseSlashCommand('/')).toBeNull();
  });
});

describe('dispatchSlash', () => {
  it('returns "sent" for plain messages and does NOT invoke any handler', () => {
    const quit = vi.fn();
    const table = buildSlashTable({ quit });
    expect(dispatchSlash('hello world', table)).toBe('sent');
    expect(quit).not.toHaveBeenCalled();
  });

  it('returns "dispatched" for /quit and invokes the handler', () => {
    const quit = vi.fn();
    const table = buildSlashTable({ quit });
    expect(dispatchSlash('/quit', table)).toBe('dispatched');
    expect(quit).toHaveBeenCalledOnce();
  });

  it('returns "unknown" for unrecognized commands', () => {
    const quit = vi.fn();
    const table = buildSlashTable({ quit });
    expect(dispatchSlash('/foo', table)).toBe('unknown');
    expect(quit).not.toHaveBeenCalled();
  });

  it('treats multi-line input as "sent" — even if first line is /quit', () => {
    const quit = vi.fn();
    const table = buildSlashTable({ quit });
    expect(dispatchSlash('/quit\nthen do X', table)).toBe('sent');
    expect(quit).not.toHaveBeenCalled();
  });

  it('passes trimmed rest to the handler', () => {
    const echo = vi.fn();
    const table = { ...buildSlashTable({ quit: vi.fn() }), echo };
    expect(dispatchSlash('/echo hi there', table)).toBe('dispatched');
    expect(echo).toHaveBeenCalledWith('hi there');
  });
});
