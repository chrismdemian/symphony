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
  | { readonly kind: 'char'; readonly char: string }
  /**
   * Phase 3F.3 — palette-only command with no global hotkey. Never
   * matches a keystroke; renders as an empty key column in the palette.
   * Use for actions like "View answered questions" that we don't want
   * to consume a top-level chord for.
   */
  | { readonly kind: 'none' };

/**
 * Scope semantics:
 *   - `'global'` — fires regardless of focus (Tab, Ctrl+C, Ctrl+P palette).
 *   - `'main'`   — fires when focus is on a main panel (chat/workers/output)
 *                  but NOT inside a popup. Phase 3F.1: `?` help and `Ctrl+Q`
 *                  questions migrated here so they don't intercept printable
 *                  characters typed into the command palette filter.
 *   - FocusKey   — fires only when that specific main panel is focused.
 *   - popup key  — fires only while that popup is on top of the focus stack.
 */
export type CommandScope = 'global' | 'main' | FocusKey | (string & {});

/** Phase 3F.1 — main-panel scope keys (chat/workers/output). */
export const MAIN_FOCUS_KEYS: readonly FocusKey[] = ['chat', 'workers', 'output'];

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
  /**
   * Phase 3F.1 — popup-internal navigation flag. When `true`, this
   * command is excluded from the command-palette listing (otherwise the
   * palette could list its own `palette.invoke`, leading to recursion
   * when the user picks it). The HelpOverlay groups these under
   * "Popup nav" so they remain discoverable. Default `false`.
   *
   * Use for: `palette.dismiss`/`palette.invoke`/`palette.next`/`palette.prev`
   * and the analogous Esc/Enter/arrow handlers in WorkerSelector,
   * HelpOverlay, and QuestionPopup. Do NOT use for user-actionable
   * commands at popup scope — those should still appear in the palette.
   */
  readonly internal?: boolean;
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
    case 'none':
      return '';
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
 * Phase 3F.1 — true when `scope` names one of the three main-panel focus
 * keys. `main`-scoped commands are active when this is true; they're
 * silenced inside popups so popup filters can capture printable chars
 * (`?`, etc.) without firing global help.
 */
function isMainScope(scope: string): boolean {
  return MAIN_FOCUS_KEYS.includes(scope as FocusKey);
}

/**
 * Filter the registry to commands relevant for the current focus scope,
 * applying lazygit-style dedup: per-panel scope overrides global on the
 * same key. Also drops `displayOnScreen: false` commands when `forBar`
 * is true (palette mode keeps everything).
 *
 * Phase 3F.1: `'main'` scope is active when `scope` is one of
 * `MAIN_FOCUS_KEYS`. Specific panel scopes still win over `'main'` on
 * key collisions.
 *
 * Throws `DuplicateKeybindError` if two commands at the same scope bind
 * the same key (audit M3).
 */
export function selectCommands(
  registry: readonly Command[],
  scope: string,
  forBar: boolean,
): readonly Command[] {
  const mainActive = isMainScope(scope);
  // Group by serialized key — track whether we've seen a per-scope match.
  // Phase 3F.3 audit C2: `formatKey({kind:'none'})` is `''`. Two commands
  // sharing that empty key (e.g. multiple palette-only `'none'` entries)
  // would dedup against each other and one would silently win, OR throw
  // `DuplicateKeybindError('', ...)` with a useless message. Skip dedup
  // entirely for `kind: 'none'` since they have no chord to collide on.
  // Each is added to the result list as-is.
  const byKey = new Map<string, Command>();
  const noneKey: Command[] = [];
  for (const cmd of registry) {
    if (cmd.scope === 'global') {
      // always considered
    } else if (cmd.scope === 'main') {
      if (!mainActive) continue;
    } else if (cmd.scope !== scope) {
      continue;
    }
    if (forBar && !cmd.displayOnScreen) continue;
    if (cmd.key.kind === 'none') {
      noneKey.push(cmd);
      continue;
    }
    const keyId = formatKey(cmd.key);
    const existing = byKey.get(keyId);
    if (existing === undefined) {
      byKey.set(keyId, cmd);
      continue;
    }
    // Specificity: specific panel scope > 'main' > 'global'.
    const existingRank = scopeSpecificity(existing.scope);
    const incomingRank = scopeSpecificity(cmd.scope);
    if (incomingRank > existingRank) {
      byKey.set(keyId, cmd);
      continue;
    }
    if (incomingRank === existingRank && existingRank === SPECIFIC_SCOPE_RANK) {
      // Same-specific-scope same-key collision — audit M3 footgun.
      throw new DuplicateKeybindError(keyId, cmd.scope, existing.id, cmd.id);
    }
    // Otherwise the existing entry wins (lower-rank incoming is dropped).
  }
  return [...Array.from(byKey.values()), ...noneKey];
}

const SPECIFIC_SCOPE_RANK = 2;

function scopeSpecificity(scope: CommandScope): number {
  if (scope === 'global') return 0;
  if (scope === 'main') return 1;
  return SPECIFIC_SCOPE_RANK;
}

/**
 * Phase 3F.1 — palette/help-overlay flat listing. Returns every
 * registered command with NO scope filtering, deduped by `id` (last
 * registration wins on id collision). Used by the command palette and
 * the help overlay; both surfaces want to see the full registry,
 * grouping/labelling by scope themselves rather than pre-filtering.
 *
 * Distinct from `selectCommands` — that filters by current focus and
 * applies key-collision dedup (per-panel beats main beats global).
 * `selectAllCommands` does neither: a help-overlay reader should see
 * `?` listed under "Main" alongside Tab listed under "Global".
 */
export function selectAllCommands(
  registry: readonly Command[],
): readonly Command[] {
  const byId = new Map<string, Command>();
  for (const cmd of registry) {
    byId.set(cmd.id, cmd);
  }
  return Array.from(byId.values());
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
    // Phase 3F.3: skip palette-only commands (kind 'none' → empty key
    // string) — they have no chord to advertise on the bar.
    if (cmd.key.kind === 'none') continue;
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
