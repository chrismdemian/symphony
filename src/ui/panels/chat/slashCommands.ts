/**
 * Pure slash-command parser + dispatch table.
 *
 * Rules (Plan §3B Architecture, slash command parsing):
 *   1. Multi-line buffers are NEVER slash commands. `/quit\nthen do X`
 *      is a real message — the user pressed Ctrl+J or shifted Enter
 *      between the slash line and the rest. Treat as literal.
 *   2. Single-line: trim leading/trailing whitespace, then match
 *      `^/([a-z]+)\b` case-insensitively. `/quit`, `/QUIT`,
 *      `   /quit  ` all hit. `/foo123` does NOT match (digits break
 *      the alpha word boundary so the parser yields `foo`, then dispatch
 *      drops it as unknown).
 *   3. Anything trailing the command name is captured as `rest` so
 *      future commands like `/w violin` can take args.
 *
 * Phase 3B.2 ships only `/quit`. 3F adds `/workers`, `/tasks`, etc.
 *
 * Centralizing the dispatch table here keeps `ChatPanel.tsx` thin and
 * lets the unit tests exercise parser + table independently.
 */

const SLASH_REGEX = /^\/([a-z]+)\b\s*(.*)$/i;

export interface ParsedSlashCommand {
  readonly command: string;
  readonly rest: string;
}

/**
 * Returns `null` when `text` is NOT a slash command (multi-line, no
 * leading slash after trim, or the prefix doesn't match). Otherwise the
 * lowercased command name + trailing rest.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  // Multi-line bypass — check BEFORE trim.
  if (text.includes('\n')) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const match = SLASH_REGEX.exec(trimmed);
  if (match === null) return null;
  const name = match[1];
  const rest = match[2] ?? '';
  if (name === undefined || name.length === 0) return null;
  return { command: name.toLowerCase(), rest: rest.trim() };
}

/** Side-effect-bearing handler for one slash command. */
export type SlashHandler = (rest: string) => void;

export interface SlashHandlers {
  readonly quit: () => void;
  /**
   * Phase 3H.1 — `/config` opens the settings popup. Optional during
   * 3H transition so pre-3H.1 tests that omit it still type-check.
   * When omitted, the `config` slash command is NOT registered in the
   * dispatch table — `/config` becomes "unknown" so the chat panel
   * surfaces "Unknown command: config" rather than silently swallowing.
   * (Audit 3H.1 M2 — silent-no-op was the previous failure mode.)
   */
  readonly openSettings?: () => void;
}

export interface SlashTable {
  readonly [name: string]: SlashHandler | undefined;
}

export function buildSlashTable(handlers: SlashHandlers): SlashTable {
  const table: { [name: string]: SlashHandler | undefined } = {
    quit: () => handlers.quit(),
  };
  if (handlers.openSettings !== undefined) {
    const open = handlers.openSettings;
    table['config'] = () => open();
  }
  return table;
}

/**
 * Parses + dispatches in one shot.
 *
 * Returns:
 *   - `'sent'` — text is NOT a command, caller should forward to Maestro
 *   - `'dispatched'` — handler ran, do NOT forward
 *   - `'unknown'` — text looks like a command but is not in the table;
 *     caller decides whether to surface an inline error or forward
 *     literally. 3B.2 surfaces an inline error so users learn the
 *     command isn't recognized rather than seeing it sent silently.
 */
export type SlashOutcome = 'sent' | 'dispatched' | 'unknown';

export function dispatchSlash(text: string, table: SlashTable): SlashOutcome {
  const parsed = parseSlashCommand(text);
  if (parsed === null) return 'sent';
  const handler = table[parsed.command];
  if (handler === undefined) return 'unknown';
  handler(parsed.rest);
  return 'dispatched';
}
