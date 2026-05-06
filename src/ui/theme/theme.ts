/**
 * Symphony color palette + token resolver.
 *
 * Pattern ported from OpenCode `research/repos/opencode/packages/opencode/src/cli/cmd/tui/context/theme.tsx`:
 * - `defs` = named hex aliases (or, in the 16-color variant, ANSI named colors)
 * - `theme` = semantic-token → hex-or-ANSI-name-or-ref
 * - `resolveTheme()` = walks ref chains, detects cycles, returns a flat
 *   `Record<ThemeToken, string>` of resolved values.
 *
 * Phase 3A locked the truecolor palette (`SYMPHONY_THEME`). Phase 3H.2
 * adds `SYMPHONY_THEME_16` for terminals that don't support 24-bit
 * (legacy conhost outside Windows Terminal — see 3A m8). The picker
 * `pickThemeJson(autoFallback)` probes terminal capability once at boot
 * and returns the right variant; `<ThemeProvider>` lifts it into state
 * so config flips (`<leader>t`, settings popup toggle) hot-swap without
 * remount. Token NAMES are identical across variants — every consumer
 * (`<Text color={theme['accent']}>`) keeps working unchanged.
 */

type Hex = `#${string}`;
/**
 * ANSI named colors recognized by Ink/chalk. When a `ColorValue` matches
 * one of these AND it isn't a defined ref-target in the same theme JSON,
 * the resolver returns the name as-is and Ink/chalk handle the terminal
 * mapping. The 16-color fallback theme uses these names directly so a
 * conhost-class terminal renders the right hue without a 24-bit escape.
 */
const ANSI_NAMED_COLORS: ReadonlySet<string> = new Set([
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'gray',
  'grey',
  'blackBright',
  'redBright',
  'greenBright',
  'yellowBright',
  'blueBright',
  'magentaBright',
  'cyanBright',
  'whiteBright',
]);
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
    gold: '#D4A843',
    goldLight: '#E5C07B',
    red: '#E06C75',
    magenta: '#C678DD',
    grayDim: '#555555',
    grayMuted: '#888888',
    textLight: '#E0E0E0',
    // Phase 3F.4 — diff coloring follows universal git convention.
    // Distinct from Symphony's `success` (gold) — diffs need green/red
    // for the additions/removals to read at a glance.
    diffAddGreen: '#98C379',
    diffRemoveRed: '#E06C75',
    diffHunkCyan: '#56B6C2',
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
    // Phase 3D.2 — json-render integration. All refs to existing palette
    // values so the locked palette stays exactly as documented in
    // PLAN.md §3A. NO `jsonRenderBackground` token (same reason as no
    // `outputBackground`: terminal default).
    jsonRenderBorder: 'violet',
    jsonRenderHeading: 'gold',
    jsonRenderText: 'textLight',
    jsonRenderMuted: 'grayMuted',
    jsonRenderError: 'red',
    // Phase 3F.4 — code highlighting tokens. Keywords get the brand
    // accent (violet); strings get the secondary brand color (gold);
    // comments + numbers get neutral muted/light tones so the eye
    // tracks structure without being shouted at.
    syntaxKeyword: 'violet',
    syntaxString: 'gold',
    syntaxComment: 'grayMuted',
    syntaxNumber: 'goldLight',
    // Diff lines — git-convention green/red/cyan. Distinct from
    // success/error so the diff reads correctly even if the surrounding
    // context uses gold for "success" elsewhere on the panel.
    diffAdd: 'diffAddGreen',
    diffRemove: 'diffRemoveRed',
    diffHunk: 'diffHunkCyan',
    diffMeta: 'grayMuted',
    diffContext: 'textLight',
  },
};

export type ThemeToken = keyof typeof SYMPHONY_THEME.theme;
export type Theme = Readonly<Record<string, string>>;

/**
 * Walk the ref chain for a single color, detecting cycles. Hex literals
 * resolve to themselves; refs look up `defs` first then `theme`. ANSI
 * named colors (`magenta`, `yellow`, `gray`, …) that AREN'T defined as
 * refs in this theme JSON terminate the walk and resolve to the name
 * itself — Ink/chalk handle the terminal-side mapping.
 *
 * Audit M4 (Phase 3A): cycle detection uses a `Set<string>` (O(1) per
 * check) and an `Array<string>` for the diagnostic chain. The previous
 * `chain.includes(value)` was O(n) per step, O(n²) total — fine for
 * Symphony's 3-deep palette but a footgun once Phase 3H accepts
 * user-supplied themes. Self-references (`a: 'a'`) are detected on
 * the first lookup attempt.
 *
 * Phase 3H.2: defs/theme refs ALWAYS win over ANSI named colors. A
 * theme that intentionally re-binds `red` to a custom hex stays
 * authoritative; only bare names that are NOT defined fall through to
 * the ANSI lookup.
 */
function resolveColor(
  value: ColorValue,
  json: ThemeJson,
  seen: Set<string>,
  chain: string[],
): string {
  if (value.startsWith('#')) return value;
  const next = json.defs?.[value] ?? json.theme[value];
  if (next !== undefined) {
    if (seen.has(value)) {
      throw new ThemeReferenceError(
        `Circular color reference: ${[...chain, value].join(' -> ')}`,
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
  if (ANSI_NAMED_COLORS.has(value)) return value;
  throw new ThemeReferenceError(
    `Color reference "${value}" not found in defs, theme, or ANSI named colors`,
  );
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

/** Convenience — resolve the locked Symphony truecolor theme. */
export function symphonyTheme(): Theme {
  return resolveTheme(SYMPHONY_THEME);
}

/**
 * Phase 3H.2 — 16-color fallback variant. Same semantic token names as
 * `SYMPHONY_THEME` (so every consumer keeps working) but defs map to
 * ANSI named colors that every terminal renders correctly.
 *
 * Hue mapping rationale:
 *   violet (brand)        → magenta        (closest hue in ANSI 16)
 *   gold (highlight)      → yellow         (warm tone)
 *   red (errors)          → red
 *   diff additions/cyan   → green / cyan   (universal git convention)
 *   text                  → white          (default foreground)
 *   muted                 → gray           (default secondary)
 *
 * Bright variants (`magentaBright`, `yellowBright`) map to the high-
 * intensity slots so contrast against active borders stays readable.
 */
export const SYMPHONY_THEME_16: ThemeJson = {
  defs: {
    violet: 'magenta',
    violetLight: 'magentaBright',
    gold: 'yellow',
    goldLight: 'yellowBright',
    // `red` and `magenta` are intentionally omitted — bare references to
    // those names fall through to ANSI named-color resolution. A def of
    // `name: name` would create a self-cycle, and rebinding `magenta`
    // to `magentaBright` would also bend `accent: 'violet' → 'magenta'`
    // through the rebind. The 16-color variant flattens nuance the
    // truecolor palette had (info vs accent both render as ANSI magenta);
    // acceptable trade-off for legacy-terminal correctness.
    grayDim: 'gray',
    // Audit M4: `grayMuted` maps to `white` rather than `gray` so panel
    // borders (`grayDim` → `gray`) stay distinguishable from muted body
    // text on the legacy conhost path this fallback exists for. On
    // truecolor terminals the distinction stays at `#555555` vs `#888888`
    // (a closer pair); 16-color forces a wider gap.
    grayMuted: 'white',
    textLight: 'white',
    diffAddGreen: 'green',
    diffRemoveRed: 'red',
    diffHunkCyan: 'cyan',
  },
  theme: SYMPHONY_THEME.theme,
};

/**
 * Phase 3H.2 — pick the theme JSON based on `autoFallback16Color`. When
 * `false`, always returns the truecolor palette. When `true`, probes
 * terminal capability and returns 16-color if truecolor isn't supported.
 *
 * `env` override (audit m3): tests pass an explicit env shape so the
 * fallback path can be exercised without mutating `process.env`.
 * Production callers omit it — `probeTruecolor` defaults to
 * `process.env`.
 */
export function pickThemeJson(
  autoFallback: boolean,
  env: NodeJS.ProcessEnv = process.env,
): ThemeJson {
  if (!autoFallback) return SYMPHONY_THEME;
  return probeTruecolor(env) ? SYMPHONY_THEME : SYMPHONY_THEME_16;
}

/**
 * Detect whether the current terminal supports 24-bit (truecolor).
 * Mirrors the env signals chalk's `supports-color` checks (audit C2);
 * see node_modules/.pnpm/chalk@VERSION/.../supports-color/index.js
 * for the full reference. Tests pass an explicit env override.
 *
 * Order:
 *   1. `NO_COLOR` → no color (per https://no-color.org).
 *   2. `FORCE_COLOR=0` → no color; `FORCE_COLOR=1|2` → not truecolor;
 *      `FORCE_COLOR=3` → truecolor (downgrade-only override).
 *   3. `COLORTERM=truecolor|24bit` → truecolor (canonical signal).
 *   4. `TERM` matches a known truecolor emulator (kitty, ghostty,
 *      wezterm, alacritty).
 *   5. `TERM_PROGRAM` matches a known truecolor program (iTerm.app v3+,
 *      vscode, ghostty).
 *   6. `WT_SESSION` set → Windows Terminal.
 *   7. `TERM_PROGRAM=Apple_Terminal` → 256-color only, explicit deny.
 *   8. Otherwise → conservative `false`. User can disable autofallback
 *      in settings if their environment is truecolor-capable but
 *      undetected.
 */
export function probeTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['NO_COLOR'] !== undefined) return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined) {
    const n = Number.parseInt(force, 10);
    if (Number.isFinite(n)) {
      if (n <= 0) return false;
      if (n >= 3) return true;
      // FORCE_COLOR=1 (basic) or 2 (256) → user explicitly downgraded
      // away from truecolor. Honor it.
      return false;
    }
  }
  const colorterm = (env['COLORTERM'] ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return true;
  const term = env['TERM'] ?? '';
  // Modern truecolor emulators self-identify via TERM. List mirrors
  // chalk/supports-color.
  if (
    term === 'xterm-kitty' ||
    term === 'xterm-ghostty' ||
    term === 'wezterm' ||
    term === 'alacritty'
  ) {
    return true;
  }
  const program = env['TERM_PROGRAM'];
  if (program === 'iTerm.app') {
    // iTerm v3+ supports truecolor. Older versions are unlikely in 2026
    // but the version string is `TERM_PROGRAM_VERSION`.
    const version = env['TERM_PROGRAM_VERSION'];
    const major = version !== undefined ? Number.parseInt(version, 10) : NaN;
    if (Number.isFinite(major) && major >= 3) return true;
    if (version === undefined) return true; // assume modern when unset
    return false;
  }
  if (program === 'vscode' || program === 'ghostty') return true;
  if (env['WT_SESSION'] !== undefined) return true;
  if (program === 'Apple_Terminal') return false;
  return false;
}
