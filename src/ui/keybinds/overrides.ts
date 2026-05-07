import type { Key } from 'ink';
import {
  formatKey,
  type Command,
  type CommandScope,
  type KeyChord,
  type SimpleChord,
} from './registry.js';

/**
 * Phase 3H.4 — keybind override application + capture helpers.
 *
 * Three pure helpers, no React, no I/O:
 *
 *   1. `applyKeybindOverrides(commands, overrides)` — replaces `key` on
 *      any non-internal command whose `id` appears in `overrides`. Used
 *      at every command-construction site (App.tsx + each panel) so
 *      user overrides apply uniformly. Internal popup-nav commands
 *      (`internal: true`) are NEVER overridden — Esc/Enter inside
 *      popups is sacred and a misbinding would brick the popup.
 *
 *   2. `chordFromInput(input, key)` — interprets one Ink `useInput`
 *      callback as a `KeyChord`. Returns `{ ok: false, reason }` for
 *      modifier-only keystrokes (Shift / Ctrl alone) and unsupported
 *      keystrokes (meta / unrecognized escape). Esc is a structural
 *      cancel signal — callers handle it BEFORE invoking this helper.
 *      Leader chords are not rebindable here (one-keystroke capture).
 *
 *   3. `detectKeybindConflicts(commands, targetId, candidate)` — returns
 *      every command whose existing key collides with `candidate` under
 *      the dispatcher's scope-specificity rules (see
 *      `selectCommands` in `registry.ts`). Same-scope same-chord is the
 *      only hard error: cross-scope reuses are fine because the
 *      dispatcher already deduplicates them at lookup time.
 *
 * The salvage layer in `config-schema.ts` ensures the on-disk record
 * we receive here is already shape-validated; this module trusts the
 * `KeyChord` type contract.
 */

/**
 * Apply per-command override map to a command list. Pure; identity-
 * preserving when no override matches (so downstream `useMemo` deps
 * don't churn unnecessarily).
 *
 * NEVER overrides:
 *   - `internal: true` — popup-internal navigation chords
 *     (Esc/Enter/arrows). Structural to popup UX.
 *   - `unbindable: true` — escape-hatch commands the user cannot
 *     recover from a bad rebind (Ctrl+C exit, Tab focus-cycle).
 *
 * Defense-in-depth: even if a malformed `keybindOverrides` entry
 * targets one of these IDs (despite the editor refusing to capture
 * them), the override is silently ignored here.
 */
export function applyKeybindOverrides<C extends Command>(
  commands: readonly C[],
  overrides: Readonly<Record<string, KeyChord>>,
): readonly C[] {
  if (Object.keys(overrides).length === 0) return commands;
  let mutated = false;
  const next: C[] = [];
  for (const cmd of commands) {
    if (cmd.internal === true || cmd.unbindable === true) {
      next.push(cmd);
      continue;
    }
    const override = overrides[cmd.id];
    if (override === undefined) {
      next.push(cmd);
      continue;
    }
    mutated = true;
    next.push({ ...cmd, key: override });
  }
  return mutated ? next : commands;
}

/**
 * Result of interpreting one Ink keystroke as a chord. Capture popups
 * branch on `ok` to either commit or surface the rejection reason.
 */
export type ChordCapture =
  | { readonly ok: true; readonly chord: KeyChord }
  | { readonly ok: false; readonly reason: string };

/**
 * Allowed printable characters for `Ctrl+<char>` chord. Mirrors the
 * dispatcher's `simpleChordMatches('ctrl', ...)` matcher: ASCII alnum +
 * common punctuation that survives terminal escape decoding. Excludes
 * `c` (Ctrl+C is the launcher exit signal — we conflict-detect rather
 * than refuse capture, but the capture itself is permitted so the user
 * sees the explicit "Conflicts with exit" message).
 */
const CTRL_ALLOWED_CHAR = /^[a-zA-Z0-9,./;'\-=[\]\\]$/u;

/**
 * Single-character printable allowance for plain `char` chord. Strict
 * ASCII printable range minus space (space is reserved by SettingsPanel
 * for bool toggle and would conflict). Unicode beyond ASCII is rejected
 * because formatKey/chord equality treat each char as one code unit and
 * higher-plane glyphs are inconsistent across terminals.
 */
const CHAR_ALLOWED = /^[!-~]$/u;

/**
 * Interpret one Ink `useInput` callback as a `KeyChord`. Returns
 * `{ ok: false, reason }` when the keystroke is unbindable; the capture
 * popup surfaces the reason inline + via toast.
 *
 * Esc is NOT handled here — capture popups consume Esc as cancel BEFORE
 * dispatching to this helper. Tab/Return/arrows ARE bindable (they're
 * already used as chords in the dispatcher).
 *
 * Leader chords (two-keystroke) cannot be captured via this helper —
 * the editor lists them but disables Enter on the row. Direct edit of
 * `~/.symphony/config.json` remains the path for leader rebinds.
 */
export function chordFromInput(input: string, key: Key): ChordCapture {
  // Special keys first — Shift+Tab (a real chord) has empty `input` and
  // `key.shift = true`, so it would fall into the modifier-only branch
  // below. Branch on `key.tab`/`key.return`/arrows BEFORE checking the
  // modifier-only sentinel.
  if (key.tab) return { ok: true, chord: { kind: 'tab', shift: key.shift === true } };
  if (key.return) return { ok: true, chord: { kind: 'return' } };
  if (key.upArrow) return { ok: true, chord: { kind: 'upArrow' } };
  if (key.downArrow) return { ok: true, chord: { kind: 'downArrow' } };
  if (key.leftArrow) return { ok: true, chord: { kind: 'leftArrow' } };
  if (key.rightArrow) return { ok: true, chord: { kind: 'rightArrow' } };
  if (key.pageUp) return { ok: true, chord: { kind: 'pageUp' } };
  if (key.pageDown) return { ok: true, chord: { kind: 'pageDown' } };
  // Modifier-only — Ink fires this when the user holds Shift/Ctrl alone.
  if (input.length === 0 && (key.shift || key.ctrl || key.meta)) {
    return {
      ok: false,
      reason: 'Modifier-only — press a modifier combined with another key',
    };
  }
  // Meta (Alt/Cmd) is unsupported by the chord schema today.
  if (key.meta) {
    return {
      ok: false,
      reason: 'Alt/Meta chords are not supported — use Ctrl, Tab, or a printable key',
    };
  }
  if (key.ctrl) {
    if (input.length === 1 && CTRL_ALLOWED_CHAR.test(input)) {
      return { ok: true, chord: { kind: 'ctrl', char: input.toLowerCase() } };
    }
    return {
      ok: false,
      reason: 'Unsupported Ctrl combination — pick an alphanumeric or common punctuation',
    };
  }
  if (input.length === 1 && CHAR_ALLOWED.test(input)) {
    return { ok: true, chord: { kind: 'char', char: input } };
  }
  // Multi-byte / paste-style input falls here (length > 1). These are
  // genuine paste fragments, not chords — reject.
  if (input.length > 1) {
    return { ok: false, reason: 'Multi-character input — press a single key' };
  }
  return { ok: false, reason: 'Unsupported keystroke' };
}

/**
 * Conflict detected against an existing command in the registry. The
 * editor refuses to commit a candidate when this list is non-empty;
 * the inline error names the first conflict's title + scope.
 */
export interface KeybindConflict {
  readonly id: string;
  readonly title: string;
  readonly scope: CommandScope;
  readonly key: KeyChord;
}

/**
 * Find every command whose existing key collides with `candidate` under
 * the dispatcher's scope-specificity rules.
 *
 * Mirrors `selectCommands` in `registry.ts`:
 *   - 'global' scope is ALWAYS active (collides with everything)
 *   - 'main' scope is active when the focus is one of MAIN_FOCUS_KEYS;
 *     a 'main' chord collides with another 'main' OR 'global' OR a
 *     specific-main-key chord on the same key
 *   - specific scopes (panel keys, popup keys) only collide with the
 *     same scope (different panels are isolated) OR a 'main'/'global'
 *     entry that the dispatcher would dedupe under
 *
 * For the user-facing rule we surface ALL conflicts the dispatcher
 * would dedupe across, so the user sees every shadowed binding.
 *
 * `kind: 'none'` and `kind: 'leader'` chords are not eligible for
 * collision (`none` has no chord; leader chords are excluded from
 * dedup in the dispatcher). The candidate is also rejected if it's a
 * leader — but the editor's capture path can't produce one, so this is
 * a defense-in-depth filter.
 */
export function detectKeybindConflicts(
  commands: readonly Command[],
  targetId: string,
  candidate: KeyChord,
  candidateScope: CommandScope,
): readonly KeybindConflict[] {
  if (candidate.kind === 'none' || candidate.kind === 'leader') return [];
  const candidateLabel = formatKey(candidate);
  const conflicts: KeybindConflict[] = [];
  for (const cmd of commands) {
    if (cmd.id === targetId) continue;
    if (cmd.key.kind === 'none' || cmd.key.kind === 'leader') continue;
    if (formatKey(cmd.key) !== candidateLabel) continue;
    if (!scopesCollide(candidateScope, cmd.scope)) continue;
    conflicts.push({ id: cmd.id, title: cmd.title, scope: cmd.scope, key: cmd.key });
  }
  return conflicts;
}

const MAIN_FOCUS_KEYS_LOCAL = new Set<string>(['chat', 'workers', 'output']);

/**
 * True when two scopes' chords could fire under the same conditions —
 * follows `selectCommands`'s dedup rules. The dispatcher would either
 * pick one (specific > main > global) or throw `DuplicateKeybindError`
 * for same-specific-scope collisions; either way the user-facing rule
 * is "don't bind two commands to the same chord under overlapping
 * activation conditions".
 */
function scopesCollide(a: CommandScope, b: CommandScope): boolean {
  if (a === b) return true;
  // 'global' collides with everything except a different popup scope's
  // commands — those popups push onto the focus stack and the global
  // would still fire. Treat global as universally colliding.
  if (a === 'global' || b === 'global') return true;
  // 'main' collides with the three specific main-focus keys and itself.
  if (a === 'main' && MAIN_FOCUS_KEYS_LOCAL.has(b as string)) return true;
  if (b === 'main' && MAIN_FOCUS_KEYS_LOCAL.has(a as string)) return true;
  if (a === 'main' && b === 'main') return true;
  // Different specific scopes (chat vs popup, workers vs popup) don't
  // collide — they're never simultaneously active.
  return false;
}

/**
 * Format a `SimpleChord` for surface text — wraps `formatKey` so
 * capture-popup status messages can describe the previewed chord
 * without forcing the caller to widen the type.
 */
export function describeChord(chord: KeyChord): string {
  if (chord.kind === 'none') return '(none)';
  return formatKey(chord);
}

/**
 * Drop a single key from the override record. Pure — returns a new
 * record. Used by reset paths so callers don't manually clone-and-delete.
 */
export function withoutOverride(
  current: Readonly<Record<string, KeyChord>>,
  id: string,
): Readonly<Record<string, KeyChord>> {
  if (!(id in current)) return current;
  const next = { ...current };
  delete next[id];
  return next;
}

/**
 * Set a single override entry. Pure — returns a new record. Used so
 * callers don't manually `{ ...current, [id]: chord }` (which can lose
 * type narrowing on the `KeyChord` union).
 */
export function withOverride(
  current: Readonly<Record<string, KeyChord>>,
  id: string,
  chord: KeyChord,
): Readonly<Record<string, KeyChord>> {
  return { ...current, [id]: chord };
}

/**
 * Re-export `formatKey` and the `SimpleChord` type so consumers in the
 * editor don't need a second import from `registry.ts`. Keeps the
 * editor's import surface narrow.
 */
export { formatKey };
export type { SimpleChord };
