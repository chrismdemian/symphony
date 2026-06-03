import { z } from 'zod';

/**
 * `@symphony/plugin-sdk` — manifest types + validator.
 *
 * This is an INDEPENDENT re-implementation of Symphony's host-side manifest
 * schema (`src/plugins/manifest.ts` + `src/plugins/permissions.ts` +
 * `src/plugins/paths.ts`). The SDK is a separate package and cannot import
 * the app's internals, so the schema is duplicated here on purpose. A
 * drift-lock test in the main repo (`tests/plugins/7b1-sdk-manifest-drift.unit.test.ts`)
 * asserts that BOTH validators accept and reject an identical fixture
 * matrix — if the host schema and this one ever diverge, CI fails.
 *
 * The manifest is the user's install-time consent record (spawn recipe +
 * security envelope). The SDK exposes a typed `validateManifest` so a
 * plugin author can validate their own `plugin.json` during a build step,
 * and `defineManifest` so a generator can produce a typed, pre-validated
 * object.
 */

/** Manifest schema version. Bumped only on a breaking manifest-shape change. */
export const MANIFEST_SCHEMA_VERSION = 1 as const;

/**
 * The host↔plugin contract version this SDK targets. A plugin's optional
 * `requiresPluginApi` semver range is checked against the HOST's
 * advertised version at load time; this constant is what the SDK was built
 * against. Kept byte-identical to the host's `PLUGIN_API_VERSION` by the
 * drift-lock test.
 */
export const PLUGIN_API_VERSION = '1.0.0' as const;

export const MANIFEST_CAPABILITY_FLAGS = [
  'requires:host-browser-control',
  'requires:network-egress',
  'requires:filesystem-write',
  'requires:secrets-read',
  'external-visible',
  'irreversible',
] as const;
export type ManifestCapabilityFlag = (typeof MANIFEST_CAPABILITY_FLAGS)[number];

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

/** Canonical fixed permissions, `<resource>:<action>`. */
export const FIXED_PERMISSIONS = [
  'worker:spawn',
  'worker:read',
  'project:read',
  'project:write',
  'task:read',
  'task:write',
  'voice:transcript',
  'secrets:read',
  'notify:send',
] as const;
export type FixedPermission = (typeof FIXED_PERMISSIONS)[number];

/** A validated permission — either a fixed string or a `net:<host>` grant. */
export type PluginPermission = FixedPermission | `net:${string}`;

const FIXED_SET: ReadonlySet<string> = new Set(FIXED_PERMISSIONS);

// RFC-1123-ish host: dot-separated labels, optional `:port`. Wildcard
// `*.example.com` is allowed so a plugin can scope to a subdomain tree.
// Byte-identical to `src/plugins/permissions.ts`.
const NET_HOST_RE =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/i;

export class PluginManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginManifestError';
  }
}

/**
 * Reject ids that could escape the store via path traversal or absolute
 * paths, AND `__` (the reserved `<id>__<tool>` proxy-tool namespace
 * separator). Byte-identical to `assertSafePluginId` (`src/plugins/paths.ts`).
 */
export function assertSafePluginId(id: string): string {
  const trimmed = id.trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed) || trimmed.includes('\0')) {
    throw new PluginManifestError(
      `unsafe plugin id '${id}' — must match ^[a-z0-9][a-z0-9_-]{0,63}$ ` +
        '(lowercase, no separators, no leading dot or traversal).',
    );
  }
  if (trimmed.includes('__')) {
    throw new PluginManifestError(
      `unsafe plugin id '${id}' — must not contain '__' (reserved as the tool-namespace separator).`,
    );
  }
  return trimmed;
}

function validatePermission(raw: string): PluginPermission {
  const value = raw.trim();
  if (FIXED_SET.has(value)) return value as FixedPermission;
  if (value.startsWith('net:')) {
    const host = value.slice('net:'.length);
    if (host.length > 0 && host.length <= 255 && NET_HOST_RE.test(host)) {
      return value as `net:${string}`;
    }
    throw new PluginManifestError(
      `unknown plugin permission '${value}' — must be one of ` +
        `${FIXED_PERMISSIONS.join(', ')}, or net:<host>`,
    );
  }
  throw new PluginManifestError(
    `unknown plugin permission '${value}' — must be one of ` +
      `${FIXED_PERMISSIONS.join(', ')}, or net:<host>`,
  );
}

function validatePermissions(raw: readonly string[]): readonly PluginPermission[] {
  const out: PluginPermission[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const valid = validatePermission(entry);
    if (seen.has(valid)) continue;
    seen.add(valid);
    out.push(valid);
  }
  return out;
}

const EntrypointSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  })
  .strict();

const ManifestObjectSchema = z
  .object({
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(64),
    author: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    homepage: z.string().url().optional(),
    entrypoint: EntrypointSchema,
    permissions: z.array(z.string()).default([]),
    capabilityFlags: z.array(z.enum(MANIFEST_CAPABILITY_FLAGS)).default([]),
    events: z.array(z.enum(PLUGIN_EVENTS)).default([]),
    requiresPluginApi: z.string().min(1).max(64).optional(),
    configSchema: z.record(z.string(), z.unknown()).optional(),
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

/**
 * Parse + validate an unknown value into a `PluginManifest`, throwing
 * `PluginManifestError` on any shape, id, or permission problem. Strict:
 * unknown top-level keys reject (matches the host).
 */
export function validateManifest(input: unknown): PluginManifest {
  const result = ManifestObjectSchema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first && first.path.length > 0 ? ` at "${first.path.join('.')}"` : '';
    const why = first?.message ?? 'invalid manifest';
    throw new PluginManifestError(`plugin.json invalid${where}: ${why}`);
  }
  const data = result.data;
  const safeId = assertSafePluginId(data.id);
  const permissions = validatePermissions(data.permissions);
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
 * Typed manifest-authoring helper. Accepts a partial spec (schemaVersion +
 * defaultable fields are filled), validates, and returns the canonical
 * manifest object. A generator or build step can `JSON.stringify` the
 * result into `plugin.json`.
 */
export interface DefineManifestInput {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly author: string;
  readonly description: string;
  readonly entrypoint: { readonly command: string; readonly args?: readonly string[] };
  readonly homepage?: string;
  readonly permissions?: readonly string[];
  readonly capabilityFlags?: readonly ManifestCapabilityFlag[];
  readonly events?: readonly PluginEvent[];
  readonly requiresPluginApi?: string;
  readonly configSchema?: Readonly<Record<string, unknown>>;
  readonly toolScope?: 'act' | 'both';
}

export function defineManifest(input: DefineManifestInput): PluginManifest {
  return validateManifest({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    version: input.version,
    author: input.author,
    description: input.description,
    entrypoint: { command: input.entrypoint.command, args: input.entrypoint.args ?? [] },
    ...(input.homepage !== undefined ? { homepage: input.homepage } : {}),
    permissions: input.permissions ?? [],
    capabilityFlags: input.capabilityFlags ?? [],
    events: input.events ?? [],
    ...(input.requiresPluginApi !== undefined
      ? { requiresPluginApi: input.requiresPluginApi }
      : {}),
    ...(input.configSchema !== undefined ? { configSchema: input.configSchema } : {}),
    toolScope: input.toolScope ?? 'act',
  });
}
