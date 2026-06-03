import { z } from 'zod';

import { assertSafePluginId, PluginIdError } from './paths.js';
import {
  PluginPermissionError,
  validatePermissions,
  type PluginPermission,
} from './permissions.js';

/**
 * Phase 7A — `plugin.json` manifest schema + parser.
 *
 * Borrows Omi's "name + description + JSON-Schema-of-inputs" tool shape
 * (`research/omi-sdks-plugins-analysis.md`) but adds what Omi lacks and
 * Symphony needs from day one: a `schemaVersion`, a validated machine
 * `id` (Omi self-declares unsigned id strings — rejected), a declared
 * `permissions` consent list, capability flags that drive the existing
 * tier/away/automation enforcement (`requires:host-browser-control` →
 * `CapabilityEvaluator`), and a `requiresPluginApi` semver gate so a
 * breaking change to the host↔plugin contract is a clean refusal-to-load,
 * not a flag day.
 *
 * Strict by design: unknown top-level keys REJECT (matches the droid
 * parser philosophy — a typo in a security-relevant manifest must fail
 * loud, never silently enforce nothing). Tools themselves are NOT listed
 * in the manifest; they're discovered at runtime via MCP `listTools()`
 * over the plugin's stdio transport. The manifest declares the spawn
 * recipe + the security envelope; the protocol declares the tools.
 */

/** Manifest schema version. Bumped only on a breaking manifest-shape change. */
export const MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * The host↔plugin contract version Symphony advertises. A plugin's
 * optional `requiresPluginApi` semver range is checked against this at
 * load time. Bump the MAJOR when the proxy/event contract breaks.
 */
export const PLUGIN_API_VERSION = '1.0.0' as const;

/**
 * Manifest-form capability flags (colon-delimited, browser-extension
 * style) and the Symphony-native flags a plugin may also declare. These
 * are translated to `CapabilityFlag` (dash form) in `permissions.ts` and
 * attached to every proxy tool the plugin exposes, so the existing
 * `CapabilityEvaluator` gates them by tier / away-mode / automation with
 * zero new enforcement code.
 *
 * `writes-source` is deliberately NOT accepted — it auto-denies every
 * tool (it's the Maestro-delegator fence) and would make a plugin inert.
 */
export const MANIFEST_CAPABILITY_FLAGS = [
  'requires:host-browser-control',
  'requires:network-egress',
  'requires:filesystem-write',
  'requires:secrets-read',
  'external-visible',
  'irreversible',
] as const;
export type ManifestCapabilityFlag = (typeof MANIFEST_CAPABILITY_FLAGS)[number];

/**
 * Event capabilities a plugin may subscribe to. v1 dispatches the
 * broker-backed events that fire in Maestro's MCP child process (where
 * the plugin host lives). `onVoiceTranscript` (Process A / always-capture)
 * and `onUserCommand` (TUI slash surface, Phase 7C) are declared in the
 * vocabulary but NOT yet delivered — a plugin may list them without error
 * so its manifest is forward-compatible; the host logs that they're
 * deferred. See `host.ts`.
 */
export const PLUGIN_EVENTS = [
  'onTaskCreated',
  'onTaskCompleted',
  'onTaskFailed',
  'onWorkerSpawned',
  'onWorkerCompleted',
  'onVoiceTranscript',
  'onUserCommand',
] as const;
export type PluginEvent = (typeof PLUGIN_EVENTS)[number];

/**
 * Events the host actually SOURCES + delivers in Phase 7A — the cleanly
 * available broker callbacks (`onTaskStatusChange`, `onWorkerStatusChange`).
 * `onTaskCreated` / `onWorkerSpawned` (need create/spawn hooks) and
 * `onVoiceTranscript` (Process A / always-capture) / `onUserCommand` (TUI
 * slash surface, Phase 7C) are accepted in manifests for forward-
 * compatibility but not yet delivered; the host logs a one-time notice.
 */
export const DELIVERED_PLUGIN_EVENTS: readonly PluginEvent[] = [
  'onTaskCompleted',
  'onTaskFailed',
  'onWorkerCompleted',
];

const EntrypointSchema = z
  .object({
    /** Executable to spawn (PATH name like `node`, or absolute path). */
    command: z.string().min(1),
    /**
     * Args passed to the executable. A relative path arg is resolved
     * against the plugin's install dir at spawn time (see `client.ts`).
     */
    args: z.array(z.string()).default([]),
  })
  .strict();

const ManifestObjectSchema = z
  .object({
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    /** Machine id — namespace prefix + install dir. Validated below. */
    id: z.string().min(1).max(64),
    /** Human display name. */
    name: z.string().min(1).max(120),
    /** Plugin's own version (free-form; informational). */
    version: z.string().min(1).max(64),
    author: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    homepage: z.string().url().optional(),
    entrypoint: EntrypointSchema,
    permissions: z.array(z.string()).default([]),
    capabilityFlags: z.array(z.enum(MANIFEST_CAPABILITY_FLAGS)).default([]),
    events: z.array(z.enum(PLUGIN_EVENTS)).default([]),
    /**
     * Optional semver range the plugin requires of Symphony's plugin API.
     * Checked against `PLUGIN_API_VERSION` at load. Omitted → no gate.
     */
    requiresPluginApi: z.string().min(1).max(64).optional(),
    /**
     * Phase 7C will render a config editor from this. Accepted + stored
     * verbatim in 7A but not consumed. Passthrough JSON object.
     */
    configSchema: z.record(z.string(), z.unknown()).optional(),
    /**
     * Scope for this plugin's proxy tools. `'act'` (default) exposes them
     * only in ACT mode (conservative — plugin tools do things); `'both'`
     * also exposes them while Maestro plans (for read-only plugins).
     */
    toolScope: z.enum(['act', 'both']).default('act'),
  })
  .strict();

export interface PluginManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly author: string;
  readonly description: string;
  readonly homepage?: string;
  readonly entrypoint: { readonly command: string; readonly args: readonly string[] };
  readonly permissions: readonly PluginPermission[];
  readonly capabilityFlags: readonly ManifestCapabilityFlag[];
  readonly events: readonly PluginEvent[];
  readonly requiresPluginApi?: string;
  readonly configSchema?: Readonly<Record<string, unknown>>;
  readonly toolScope: 'act' | 'both';
}

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginManifestError';
  }
}

export class PluginApiMismatchError extends Error {
  readonly required: string;
  readonly current: string;
  constructor(required: string, current: string) {
    super(
      `plugin requires plugin-api '${required}' but this Symphony provides '${current}'`,
    );
    this.name = 'PluginApiMismatchError';
    this.required = required;
    this.current = current;
  }
}

/**
 * Parse + validate an unknown value into a `PluginManifest`. Throws
 * `PluginManifestError` (shape/strictness), `PluginIdError` (unsafe id),
 * or `PluginPermissionError` (unknown permission). Does NOT check the
 * api-version gate — that's `assertPluginApiCompatible`, called by the
 * loader so a parsed-but-incompatible manifest can still be listed by the
 * CLI.
 */
export function parsePluginManifest(input: unknown): PluginManifest {
  const result = ManifestObjectSchema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
    const why = first?.message ?? 'invalid manifest';
    throw new PluginManifestError(`plugin.json invalid${where}: ${why}`);
  }
  const data = result.data;

  // Hard security boundary — the id is a path segment AND the tool
  // namespace prefix. Re-validate here (the zod string bound is not
  // sufficient) so a bad id never reaches the filesystem or the registry.
  let safeId: string;
  try {
    safeId = assertSafePluginId(data.id);
  } catch (err) {
    if (err instanceof PluginIdError) throw new PluginManifestError(err.message);
    throw err;
  }

  let permissions: readonly PluginPermission[];
  try {
    permissions = validatePermissions(data.permissions);
  } catch (err) {
    if (err instanceof PluginPermissionError) throw new PluginManifestError(err.message);
    throw err;
  }

  return {
    schemaVersion: data.schemaVersion,
    id: safeId,
    name: data.name,
    version: data.version,
    author: data.author,
    description: data.description,
    ...(data.homepage !== undefined ? { homepage: data.homepage } : {}),
    entrypoint: { command: data.entrypoint.command, args: data.entrypoint.args },
    permissions,
    capabilityFlags: data.capabilityFlags,
    events: data.events,
    ...(data.requiresPluginApi !== undefined
      ? { requiresPluginApi: data.requiresPluginApi }
      : {}),
    ...(data.configSchema !== undefined ? { configSchema: data.configSchema } : {}),
    toolScope: data.toolScope,
  };
}

/**
 * Throw `PluginApiMismatchError` when a manifest's `requiresPluginApi`
 * range is not satisfied by `PLUGIN_API_VERSION`. No-op when the field is
 * absent.
 */
export function assertPluginApiCompatible(manifest: PluginManifest): void {
  if (manifest.requiresPluginApi === undefined) return;
  if (!satisfiesPluginApi(manifest.requiresPluginApi, PLUGIN_API_VERSION)) {
    throw new PluginApiMismatchError(manifest.requiresPluginApi, PLUGIN_API_VERSION);
  }
}

interface SemVer {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseSemVer(raw: string): SemVer | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (m === null) return undefined;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function gte(a: SemVer, b: SemVer): boolean {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

/**
 * Minimal semver-range satisfaction for the realistic manifest forms,
 * implemented inline to avoid pulling a full semver dependency into a
 * security-relevant parse path. Supported `required` forms:
 *   - `*` / `x` → always satisfied
 *   - exact `1.2.3` → current must equal
 *   - caret `^1.2.3` → same major AND current >= required
 *   - `>=1.2.3` → current >= required
 *   - major-only `1` or `1.x` → major must match
 * Anything else returns false (fail-closed — refuse to load rather than
 * guess a loose match for a security boundary).
 */
export function satisfiesPluginApi(required: string, current: string): boolean {
  const req = required.trim();
  const cur = parseSemVer(current);
  if (cur === undefined) return false;
  if (req === '*' || req === 'x' || req === 'X') return true;

  const caret = req.startsWith('^');
  const gteRange = req.startsWith('>=');
  const core = caret ? req.slice(1) : gteRange ? req.slice(2).trim() : req;

  const majorOnly = /^(\d+)(\.[xX*])?$/.exec(core);
  if (majorOnly !== null && !caret && !gteRange) {
    return cur.major === Number(majorOnly[1]);
  }

  const reqVer = parseSemVer(core);
  if (reqVer === undefined) return false;
  if (caret) return cur.major === reqVer.major && gte(cur, reqVer);
  if (gteRange) return gte(cur, reqVer);
  return cur.major === reqVer.major && cur.minor === reqVer.minor && cur.patch === reqVer.patch;
}
