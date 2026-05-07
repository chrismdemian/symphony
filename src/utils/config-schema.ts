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
  leaderTimeoutMs: z.number().int().min(100).max(1000).default(300),
  keybindOverrides: z.record(z.string(), KeyChordSchema).default({}),
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
