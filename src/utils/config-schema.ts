import { z } from 'zod';
import type { KeyChord, SimpleChord } from '../ui/keybinds/registry.js';

/**
 * Phase 3H.1 — Symphony user-config schema.
 *
 * Stored at `~/.symphony/config.json` (override via `SYMPHONY_CONFIG_FILE`).
 * Pure types + zod validators — no I/O. The runtime loader / atomic writer
 * lives in `./config.ts`. The TUI popup (`<SettingsPanel>`) renders the
 * parsed result in 3H.1 (read-only) and edits it in 3H.2.
 *
 * Schema versioning: `schemaVersion: 1` is present from day one so future
 * migrations can branch on it. A file with `schemaVersion: 2` returned by
 * a future build is rejected by today's loader, falls back to defaults +
 * warning ("config.json schemaVersion 2 from a newer Symphony — using
 * defaults this session"). Forward-compatibility is NOT a goal of 3H.1 —
 * matching versions is.
 *
 * Why partial-defaults rather than strict-required: users edit this file
 * by hand. A missing field should mean "use the default", not "error".
 * Schema-level `.default(...)` covers the common case. `parseConfig` adds
 * field-by-field salvage for malformed values (out-of-range int, wrong
 * type) so a single bad field doesn't reset the whole file.
 *
 * Non-goals for 3H.1 (deferred to 3H.2/3/4 per glowing-toasting-pillow.md):
 *   - The schema fields are PRESENT today, but most have no consumer:
 *     Maestro doesn't read `modelMode`, the queue doesn't enforce
 *     `maxConcurrentWorkers`, the theme doesn't switch on
 *     `autoFallback16Color`, etc. Those wires land in 3H.2.
 *   - `keybindOverrides` is parsed and persisted but the keybind registry
 *     never reads it (3H.4 wires the override editor + application).
 */

const SCHEMA_VERSION = 1 as const;
export type SchemaVersion = typeof SCHEMA_VERSION;
export const CURRENT_SCHEMA_VERSION: SchemaVersion = SCHEMA_VERSION;

/**
 * KeyChord is shaped as a discriminated union in
 * `src/ui/keybinds/registry.ts`. We mirror it here as a zod schema so a
 * user can specify `keybindOverrides: { "palette.open": { kind: "ctrl",
 * char: "o" } }` and it round-trips into the typed `KeyChord` consumed by
 * `buildGlobalCommands` and the dispatcher. The mirror is hand-rolled
 * (rather than `z.lazy(() => SimpleChordSchema)`) because zod 4 has no
 * `.toJSON()` for discriminated unions and the leader form needs to nest
 * a SimpleChord without recursion.
 */
const SimpleChordSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tab'), shift: z.boolean().optional() }),
  z.object({ kind: z.literal('escape') }),
  z.object({ kind: z.literal('return') }),
  z.object({ kind: z.literal('leftArrow') }),
  z.object({ kind: z.literal('rightArrow') }),
  z.object({ kind: z.literal('upArrow') }),
  z.object({ kind: z.literal('downArrow') }),
  z.object({ kind: z.literal('pageUp') }),
  z.object({ kind: z.literal('pageDown') }),
  z.object({ kind: z.literal('ctrl'), char: z.string().min(1).max(1) }),
  z.object({ kind: z.literal('char'), char: z.string().min(1).max(1) }),
]);

const KeyChordSchema: z.ZodType<KeyChord> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tab'), shift: z.boolean().optional() }),
  z.object({ kind: z.literal('escape') }),
  z.object({ kind: z.literal('return') }),
  z.object({ kind: z.literal('leftArrow') }),
  z.object({ kind: z.literal('rightArrow') }),
  z.object({ kind: z.literal('upArrow') }),
  z.object({ kind: z.literal('downArrow') }),
  z.object({ kind: z.literal('pageUp') }),
  z.object({ kind: z.literal('pageDown') }),
  z.object({ kind: z.literal('ctrl'), char: z.string().min(1).max(1) }),
  z.object({ kind: z.literal('char'), char: z.string().min(1).max(1) }),
  z.object({ kind: z.literal('none') }),
  z.object({
    kind: z.literal('leader'),
    lead: SimpleChordSchema as unknown as z.ZodType<SimpleChord>,
    second: SimpleChordSchema as unknown as z.ZodType<SimpleChord>,
  }),
]);

export const SymphonyConfigSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  modelMode: z.enum(['opus', 'mixed']).default('mixed'),
  maxConcurrentWorkers: z.number().int().min(1).max(32).default(4),
  /**
   * Phase 3O.1 — auto-merge policy. After `finalize` succeeds on a worker
   * branch without an explicit `merge_to`, the AutoMergeDispatcher routes:
   *   - `'ask'` (default): enqueue a `y/n` question + emit an `asked`
   *     system row. User answer drives merge-or-skip.
   *   - `'auto'`: merge + cleanup worktree + emit `merged` system row.
   *   - `'never'`: emit a `ready` system row; leave branch for manual review.
   * Read fresh from disk per finalize event (mirror notifications-dispatcher
   * `loadConfig` pattern) — no live runtime propagation needed.
   */
  autoMerge: z.enum(['ask', 'auto', 'never']).default('ask'),
  notifications: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),
  /**
   * Phase 3H.3 — when true, the notifications dispatcher buffers events
   * instead of firing immediately. Flipping back to false triggers a
   * single batched-digest notification. The flag is a top-level boolean
   * (rather than nested under `notifications`) so Phase 3M's dedicated
   * Away Mode keybind / status indicator can toggle it without reaching
   * into a sub-object. Default false: notifications dispatch as they
   * arrive (subject to the rest of the suppression matrix).
   */
  awayMode: z.boolean().default(false),
  theme: z
    .object({
      name: z.literal('symphony').default('symphony'),
      autoFallback16Color: z.boolean().default(true),
    })
    .default({ name: 'symphony', autoFallback16Color: true }),
  defaultProjectPath: z.string().min(1).optional(),
  /**
   * Phase 5D — currently active project. Maestro and the dispatch
   * resolver default to this project when a tool call omits `project:`.
   * Stored as the registered project's NAME (mirrors what
   * `set_active_project` accepts and what `symphony list` displays).
   * `undefined` means "fall back to bootActiveProject" (the project
   * registered at `defaultProjectPath`, else first registered).
   *
   * Runtime-aware field (6-site rule per 3M/3S): `server.ts` resolves
   * `bootActiveProject` at startup and updates the dispatch-context
   * cursor via `runtime.setActiveProject`. Disk read happens once at
   * boot; subsequent switches flow disk → dispatch via the RPC.
   *
   * Validation against `projectStore` happens at the consumer (boot
   * resolver + `set_active_project` MCP tool), NOT at the schema layer:
   * a Zod schema can't read a live registry, and rejecting a name on
   * config read would orphan the user's last-active project after a
   * `symphony remove + symphony add` round-trip. The boot resolver
   * tolerates an unknown name and falls back with a warning.
   */
  activeProject: z.string().min(1).optional(),
  leaderTimeoutMs: z.number().int().min(100).max(1000).default(300),
  keybindOverrides: z.record(z.string(), KeyChordSchema).default({}),
  /**
   * Phase 3S — global autonomy tier. Controls the dispatch-context
   * cursor's `tier` value, which the capability evaluator reads on every
   * tool call to gate flag-floor enforcement. Cycled via Ctrl+Y in the
   * TUI (`scope: 'global'`).
   *
   * Tier 1 = Free reign (no notifications), Tier 2 = Notify (default,
   * matches `DEFAULT_DISPATCH_CONTEXT.tier` in
   * `orchestrator/capabilities.ts`), Tier 3 = Confirm. Capability-flag
   * floors apply on top: `requires-host-browser-control` requires Tier 3
   * exactly; `requires-secrets-read` and `requires-network-egress-
   * uncontrolled` require Tier 2 minimum.
   *
   * Runtime-aware field (6-site rule per 3M): mirror `awayMode`'s
   * server-side propagation seam (`bootAutonomyTier` +
   * `runtime.setAutonomyTier`), not just disk-write plumbing. The
   * dispatcher's tier cursor is updated in-memory by the RPC; disk read
   * happens once at boot.
   */
  autonomyTier: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  /**
   * Phase 5F — TUI project filter. `'all'` shows workers / queue / deps
   * across every registered project (default, preserves pre-5F behavior).
   * `'active'` scopes those panels to the active project's path
   * (see `activeProject` above). When `activeProject` is `undefined`,
   * `'active'` is a visual no-op — the chip annotates `(no active
   * project)` so the user knows the filter is inert.
   *
   * Client-side only (5 cascade sites, NOT 6): no `runtime.setProjectFilter`
   * RPC because Maestro doesn't read this — it's a TUI display concern.
   * The 6-site pattern (3M `awayMode` / 3S `autonomyTier`) applies only
   * when the dispatcher's context cursor reads the field on every tool
   * call. The 5-site pattern (3O.1 `autoMergePolicy`) applies when the
   * field stays disk-resident.
   */
  tuiProjectFilter: z.enum(['all', 'active']).default('all'),
  /**
   * Phase 6A/6B — voice input subsystem.
   *
   * `enabled: false` is the default (opt-in feature). When false, the
   * voice bridge does NOT auto-spawn from `symphony start`; only
   * `symphony voice diagnose` / `symphony voice transcribe` boot it.
   *
   * VAD knobs (6A):
   *   - `vadThreshold` (0..1, default 0.5): Silero speech-probability
   *     gate. Higher = louder environments. The Silero default.
   *   - `vadMinSpeechMs` (50..2000, default 100): run-up before
   *     emitting `speech_start` — filters single tongue-clicks.
   *   - `vadMinSilenceMs` (100..3000, default 400): run-down before
   *     emitting `speech_end` — keeps natural pauses inside one segment.
   *
   * STT knobs (6B):
   *   - `sttModel` (`'moonshine/base'` | `'moonshine/tiny'`, default
   *     `'moonshine/base'`): Moonshine model id. `base` is 61M params,
   *     ~5% WER; `tiny` is 27M, ~13% WER for low-resource devices.
   *   - `maxUtteranceSeconds` (5..90, default 30): hard cap on utterance
   *     length. On hard-cap, the bridge force-flushes a `final` event
   *     and emits a `warning` so the TUI can show "(cut at Ns)".
   *   - `partialIntervalMs` (100..1000, default 200): cadence at which
   *     the bridge re-runs Moonshine batch inference on the growing
   *     audio buffer to emit `partial` events. Lower = more responsive
   *     UI but higher CPU; higher = batchier.
   *
   * 5-site cascade (NOT 6) — voice config is client-side; the
   * dispatch-context cursor doesn't read it. Mirror of 5F
   * `tuiProjectFilter` shape. The bridge re-reads thresholds fresh on
   * each `set_threshold` RPC (reserved for 6E); 6A/6B hold them at
   * spawn time only.
   *
   * Adding a new `voice.*` field that the bridge consumes at spawn
   * time only — single touch here. The other four sites use
   * `{...current.voice, ...patch.voice}` partial-merge OR write the
   * whole `voice` object as one jsonc edit, so structural cascade is
   * automatic. Adding a `voice.*` field that the BRIDGE must
   * runtime-reload (via `{cmd:'reload_*'}`) is a separate concern —
   * the bridge wire format widens then, NOT the cascade.
   */
  voice: z
    .object({
      enabled: z.boolean().default(false),
      vadThreshold: z.number().min(0).max(1).default(0.5),
      vadMinSpeechMs: z.number().int().min(50).max(2000).default(100),
      vadMinSilenceMs: z.number().int().min(100).max(3000).default(400),
      sttModel: z
        .enum(['moonshine/base', 'moonshine/tiny'])
        .default('moonshine/base'),
      maxUtteranceSeconds: z.number().int().min(5).max(90).default(30),
      partialIntervalMs: z.number().int().min(100).max(1000).default(200),
    })
    .default({
      enabled: false,
      vadThreshold: 0.5,
      vadMinSpeechMs: 100,
      vadMinSilenceMs: 400,
      sttModel: 'moonshine/base',
      maxUtteranceSeconds: 30,
      partialIntervalMs: 200,
    }),
});

export type SymphonyConfig = z.infer<typeof SymphonyConfigSchema>;

export function defaultConfig(): SymphonyConfig {
  return SymphonyConfigSchema.parse({});
}

export interface ParseResult {
  readonly config: SymphonyConfig;
  readonly warnings: readonly string[];
}

/**
 * Parse arbitrary JSON-ish input into a `SymphonyConfig`, salvaging bad
 * fields. Strategy:
 *
 *   1. Run the schema. If it parses cleanly, return zero warnings.
 *   2. On `ZodError`, walk each issue and surface a one-line warning
 *      naming the field path. Then re-parse with the offending field
 *      stripped, so unrelated user values survive.
 *   3. If the input itself isn't an object, return defaults + one
 *      warning ("config.json root is not an object").
 *   4. The schemaVersion mismatch path returns defaults + warning per the
 *      header doc — anything other than `1` triggers full-defaults.
 *
 * The salvage loop is bounded to 16 passes; pathologically broken files
 * fall through to full-defaults rather than infinite-looping.
 */
export function parseConfig(input: unknown): ParseResult {
  if (input === null || input === undefined) {
    return { config: defaultConfig(), warnings: [] };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return {
      config: defaultConfig(),
      warnings: ['config.json root must be a JSON object — using defaults'],
    };
  }
  const obj = input as Record<string, unknown>;
  const rawVersion = obj['schemaVersion'];
  if (rawVersion !== undefined && rawVersion !== SCHEMA_VERSION) {
    return {
      config: defaultConfig(),
      warnings: [
        `config.json schemaVersion ${String(rawVersion)} (expected ${SCHEMA_VERSION}) — using defaults`,
      ],
    };
  }
  const warnings: string[] = [];
  // Phase 3H.4 — per-entry salvage for `keybindOverrides`. The 3H.1
  // salvage loop dropped the WHOLE record when ONE entry's chord shape
  // was bad (3H.1 m2). 3H.4 needs this granular: a typo in one
  // override shouldn't reset the user's other rebinds. Pre-validate
  // each value against KeyChordSchema, drop invalid entries with a
  // warning naming the command id, and replace the field with the
  // cleaned record before the schema-wide salvage runs.
  let candidate: Record<string, unknown> = { ...obj };
  const rawOverrides = candidate['keybindOverrides'];
  if (rawOverrides !== undefined) {
    const salvage = salvageKeybindOverrides(rawOverrides);
    candidate['keybindOverrides'] = salvage.cleaned;
    for (const w of salvage.warnings) {
      if (!warnings.includes(w)) warnings.push(w);
    }
  }
  for (let pass = 0; pass < 16; pass += 1) {
    const result = SymphonyConfigSchema.safeParse(candidate);
    if (result.success) {
      return { config: result.data, warnings };
    }
    const issues = result.error.issues;
    if (issues.length === 0) break;
    let stripped = false;
    for (const issue of issues) {
      const pathStr = issue.path.length === 0 ? '<root>' : issue.path.join('.');
      const warning = `config.json field "${pathStr}": ${issue.message} — using default`;
      if (!warnings.includes(warning)) warnings.push(warning);
      if (issue.path.length === 0) continue;
      candidate = stripField(candidate, issue.path as ReadonlyArray<string | number>);
      stripped = true;
    }
    if (!stripped) break;
  }
  return { config: defaultConfig(), warnings };
}

/**
 * Phase 3H.4 — per-entry salvage for the `keybindOverrides` record.
 *
 * Validates each `[id, chord]` entry against `KeyChordSchema`. Drops
 * invalid entries with a warning naming the command id. Returns the
 * cleaned record + warning lines.
 *
 * Non-record / null / array input falls through with a single warning
 * and an empty cleaned record — the schema's `.default({})` then
 * applies on the next pass through `safeParse`.
 *
 * Why this lives outside the schema-wide salvage loop: the salvage
 * loop strips the WHOLE record on a single bad entry (3H.1 m2). Per-
 * entry salvage requires the loop to walk the record, and that's
 * cleaner as a dedicated helper than a path-truncation special-case
 * inside `stripField`.
 */
interface KeybindSalvageResult {
  readonly cleaned: Record<string, KeyChord>;
  readonly warnings: readonly string[];
}

function salvageKeybindOverrides(input: unknown): KeybindSalvageResult {
  const warnings: string[] = [];
  if (input === null || input === undefined) {
    return { cleaned: {}, warnings };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return {
      cleaned: {},
      warnings: ['config.json field "keybindOverrides": expected object — dropped'],
    };
  }
  const cleaned: Record<string, KeyChord> = {};
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    const result = KeyChordSchema.safeParse(raw);
    if (result.success) {
      cleaned[id] = result.data;
      continue;
    }
    const reason = result.error.issues[0]?.message ?? 'invalid chord shape';
    warnings.push(
      `config.json field "keybindOverrides.${id}": ${reason} — entry dropped`,
    );
  }
  return { cleaned, warnings };
}

/**
 * Return a shallow-cloned object with the path-deep field deleted. Pure;
 * input is not mutated. Path elements may be string keys or numeric
 * array indices — only string keys are supported by the schema today
 * (`keybindOverrides` is a record), but the helper handles both for
 * future-proofing.
 */
function stripField(
  source: Record<string, unknown>,
  pathParts: ReadonlyArray<string | number>,
): Record<string, unknown> {
  if (pathParts.length === 0) return source;
  const head = pathParts[0];
  if (head === undefined) return source;
  const next: Record<string, unknown> = { ...source };
  if (pathParts.length === 1) {
    delete next[String(head)];
    return next;
  }
  const childKey = String(head);
  const child = next[childKey];
  if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
    next[childKey] = stripField(child as Record<string, unknown>, pathParts.slice(1));
  } else {
    delete next[childKey];
  }
  return next;
}
