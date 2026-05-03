/**
 * Symphony color palette + token resolver.
 *
 * Pattern ported from OpenCode `research/repos/opencode/packages/opencode/src/cli/cmd/tui/context/theme.tsx`:
 * - `defs` = named hex aliases
 * - `theme` = semantic-token → hex-or-ref
 * - `resolveTheme()` = walks ref chains, detects cycles, returns a flat
 *   `Record<ThemeToken, string>` of resolved hex values.
 *
 * Phase 3A ships ONE locked dark theme. Light theme + theme switching
 * are deferred to Phase 3H. Token names map directly to PLAN.md §3A's
 * locked palette: violet `#7C6FEB` brand + warm gold `#D4A843` highlight.
 */

type Hex = `#${string}`;
type Ref = string;
type ColorValue = Hex | Ref;

export interface ThemeJson {
  readonly defs?: Readonly<Record<string, ColorValue>>;
  readonly theme: Readonly<Record<string, ColorValue>>;
}

export class ThemeReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThemeReferenceError';
  }
}

export const SYMPHONY_THEME: ThemeJson = {
  defs: {
    violet: '#7C6FEB',
    violetLight: '#9E94F5',
    violetDark: '#5B4FC4',
    gold: '#D4A843',
    goldLight: '#E5C07B',
    red: '#E06C75',
    magenta: '#C678DD',
    grayDim: '#555555',
    grayMuted: '#888888',
    textLight: '#E0E0E0',
  },
  theme: {
    accent: 'violet',
    primary: 'gold',
    text: 'textLight',
    textMuted: 'grayMuted',
    border: 'grayDim',
    borderActive: 'violet',
    success: 'gold',
    warning: 'goldLight',
    error: 'red',
    info: 'magenta',
    workerRunning: 'violet',
    workerPlanning: 'violetLight',
    workerDone: 'gold',
    workerFailed: 'red',
    workerReview: 'goldLight',
    workerNeedsInput: 'magenta',
    workerPaused: 'grayMuted',
    // Phase 3D.1 — output panel tokens. All refs to existing palette
    // values so the locked palette stays exactly as documented in
    // PLAN.md §3A. NO `outputBackground` token: Ink renders against the
    // terminal default and introducing an opaque background contradicts
    // the locked-palette decision (PLAN.md §3A: "Background: terminal
    // default (dark)"). Focused border resolves through `Panel`'s focus
    // state to `borderActive`; blurred falls back to `border`.
    outputText: 'textLight',
    outputBorder: 'grayDim',
    toolPending: 'grayMuted',
    toolSuccess: 'gold',
    toolError: 'red',
    rateLimitWarning: 'goldLight',
  },
};

export type ThemeToken = keyof typeof SYMPHONY_THEME.theme;
export type Theme = Readonly<Record<string, string>>;

/**
 * Walk the ref chain for a single color, detecting cycles. Hex literals
 * resolve to themselves; refs look up `defs` first then `theme`.
 *
 * Audit M4 (Phase 3A): cycle detection uses a `Set<string>` (O(1) per
 * check) and an `Array<string>` for the diagnostic chain. The previous
 * `chain.includes(value)` was O(n) per step, O(n²) total — fine for
 * Symphony's 3-deep palette but a footgun once Phase 3H accepts
 * user-supplied themes. Self-references (`a: 'a'`) are detected on
 * the first lookup attempt.
 */
function resolveColor(
  value: ColorValue,
  json: ThemeJson,
  seen: Set<string>,
  chain: string[],
): string {
  if (value.startsWith('#')) return value;
  if (seen.has(value)) {
    throw new ThemeReferenceError(
      `Circular color reference: ${[...chain, value].join(' -> ')}`,
    );
  }
  const next = json.defs?.[value] ?? json.theme[value];
  if (next === undefined) {
    throw new ThemeReferenceError(
      `Color reference "${value}" not found in defs or theme`,
    );
  }
  seen.add(value);
  chain.push(value);
  try {
    return resolveColor(next, json, seen, chain);
  } finally {
    seen.delete(value);
    chain.pop();
  }
}

/**
 * Resolve every theme token to a flat `{token: '#rrggbb'}` map. Throws
 * `ThemeReferenceError` on missing refs or cycles. Pure — call once at
 * boot and pass the result through React context.
 */
export function resolveTheme(json: ThemeJson): Theme {
  return Object.fromEntries(
    Object.entries(json.theme).map(([key, value]) => [
      key,
      resolveColor(value, json, new Set<string>(), []),
    ]),
  );
}

/** Convenience — resolve the locked Symphony theme. */
export function symphonyTheme(): Theme {
  return resolveTheme(SYMPHONY_THEME);
}
