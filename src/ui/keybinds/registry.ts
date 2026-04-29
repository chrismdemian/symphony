import type { FocusKey } from '../focus/focus.js';

/**
 * Unified keybind / command registry.
 *
 * Pattern from OpenCode `research/repos/opencode/packages/opencode/src/cli/cmd/tui/`:
 * every action is declared once as a `Command`. The bottom keybind bar
 * reads from this registry. Phase 3F's Ctrl+P palette will read the same
 * registry — no duplication.
 *
 * Lazygit-style precedence (`pkg/gui/options_map.go:36-103`): per-panel
 * scope wins over global on the same key. Bar lookup filters to commands
 * whose `displayOnScreen` is true AND whose scope is either `'global'`
 * or matches the current focus scope. Width-overflow → ellipsis truncate.
 */

export type KeyChord =
  | { readonly kind: 'tab'; readonly shift?: boolean }
  | { readonly kind: 'escape' }
  | { readonly kind: 'return' }
  | { readonly kind: 'leftArrow' }
  | { readonly kind: 'rightArrow' }
  | { readonly kind: 'upArrow' }
  | { readonly kind: 'downArrow' }
  | { readonly kind: 'pageUp' }
  | { readonly kind: 'pageDown' }
  | { readonly kind: 'ctrl'; readonly char: string }
  | { readonly kind: 'char'; readonly char: string };

export type CommandScope = 'global' | FocusKey | (string & {});

export interface Command {
  /** Unique identifier — used for lookup and debug logs. */
  readonly id: string;
  /** Human-friendly action label, shown in the palette + bottom bar. */
  readonly title: string;
  /** Key combo that triggers the command. */
  readonly key: KeyChord;
  /** `'global'` for app-wide; FocusKey to scope to a panel; popup key for overlays. */
  readonly scope: CommandScope;
  /** When true, this command is rendered in the bottom keybind bar. */
  readonly displayOnScreen: boolean;
  /** Action invoked on key match. May be sync or return a promise. */
  readonly onSelect: () => void | Promise<void>;
  /** Optional disabled reason — when set, key is ignored and bar shows it dimmed. */
  readonly disabledReason?: string;
}

/** Render a key chord as a short user-facing string ("Tab", "Ctrl+C", "?"). */
export function formatKey(key: KeyChord): string {
  switch (key.kind) {
    case 'tab':
      return key.shift === true ? 'Shift+Tab' : 'Tab';
    case 'escape':
      return 'Esc';
    case 'return':
      return 'Enter';
    case 'leftArrow':
      return '←';
    case 'rightArrow':
      return '→';
    case 'upArrow':
      return '↑';
    case 'downArrow':
      return '↓';
    case 'pageUp':
      return 'PgUp';
    case 'pageDown':
      return 'PgDn';
    case 'ctrl':
      return `Ctrl+${key.char.toUpperCase()}`;
    case 'char':
      return key.char;
  }
}

/**
 * Audit M3 (Phase 3A): same-scope same-key conflicts produce undefined
 * ordering and are footguns for Phase 3F's dynamic registration. The
 * registry throws on conflict at selection time so the bug surfaces
 * immediately, not at user-keystroke time.
 *
 * Mirrors Phase 2A.1's `DuplicateToolRegistrationError` pattern.
 */
export class DuplicateKeybindError extends Error {
  readonly code = 'duplicate-keybind';
  readonly key: string;
  readonly scope: CommandScope;
  readonly ids: readonly [string, string];
  constructor(key: string, scope: CommandScope, idA: string, idB: string) {
    super(
      `Duplicate keybind in scope '${String(scope)}': '${key}' is bound to both '${idA}' and '${idB}'`,
    );
    this.name = 'DuplicateKeybindError';
    this.key = key;
    this.scope = scope;
    this.ids = [idA, idB];
  }
}

/**
 * Filter the registry to commands relevant for the current focus scope,
 * applying lazygit-style dedup: per-panel scope overrides global on the
 * same key. Also drops `displayOnScreen: false` commands when `forBar`
 * is true (palette mode keeps everything).
 *
 * Throws `DuplicateKeybindError` if two commands at the same scope bind
 * the same key (audit M3).
 */
export function selectCommands(
  registry: readonly Command[],
  scope: string,
  forBar: boolean,
): readonly Command[] {
  // Group by serialized key — track whether we've seen a per-scope match.
  const byKey = new Map<string, Command>();
  for (const cmd of registry) {
    if (cmd.scope !== 'global' && cmd.scope !== scope) continue;
    if (forBar && !cmd.displayOnScreen) continue;
    const keyId = formatKey(cmd.key);
    const existing = byKey.get(keyId);
    if (existing === undefined) {
      byKey.set(keyId, cmd);
      continue;
    }
    // Per-scope wins over global. Otherwise keep the first registration.
    if (existing.scope === 'global' && cmd.scope !== 'global') {
      byKey.set(keyId, cmd);
      continue;
    }
    if (existing.scope !== 'global' && cmd.scope !== 'global') {
      throw new DuplicateKeybindError(keyId, cmd.scope, existing.id, cmd.id);
    }
    // existing.scope !== 'global' && cmd.scope === 'global' → existing wins (kept).
  }
  return Array.from(byKey.values());
}

/**
 * Format a list of commands as a single-line key-hint string with
 * separator. Truncates with `…` when total width exceeds `maxWidth`.
 *
 * Mirrors lazygit `formatBindingInfos` (`pkg/gui/options_map.go:107-134`):
 * accumulate cumulative width, drop tail items that don't fit, append
 * `…` when truncation occurred.
 */
export function formatBindings(commands: readonly Command[], maxWidth: number): string {
  const SEP = '  ';
  const ELLIPSIS = ' …';
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  for (const cmd of commands) {
    const piece = `${formatKey(cmd.key)}: ${cmd.title}`;
    const cost = parts.length === 0 ? piece.length : piece.length + SEP.length;
    if (used + cost > maxWidth - ELLIPSIS.length && parts.length > 0) {
      truncated = true;
      break;
    }
    if (used + cost > maxWidth) {
      // Even the first piece doesn't fit — we'll truncate to ellipsis only.
      truncated = true;
      break;
    }
    parts.push(piece);
    used += cost;
  }
  let out = parts.join(SEP);
  if (truncated) out = `${out}${ELLIPSIS}`;
  return out;
}
