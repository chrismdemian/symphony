import type { CapabilityFlag } from '../orchestrator/types.js';
import type { ManifestCapabilityFlag } from './manifest.js';

/**
 * Phase 7A — plugin permission taxonomy + capability-flag translation.
 *
 * Two distinct concepts, intentionally separate:
 *
 *   - **Permissions** (`worker:spawn`, `net:api.notion.com`): a coarse
 *     consent list the USER approves at install time ("this plugin wants
 *     to read tasks and call api.notion.com — allow?"). They are recorded
 *     and surfaced; finer per-tool permission mapping is a follow-up (MCP
 *     `listTools()` carries no required-permission metadata, so v1 treats
 *     permissions as a manifest-level grant).
 *
 *   - **Capability flags** (`requires:host-browser-control`): the
 *     enforceable security boundary. They translate to Symphony's
 *     `CapabilityFlag` and ride on every proxy tool, so the existing
 *     `CapabilityEvaluator` gates them by autonomy tier / away mode /
 *     automation context with zero new enforcement code.
 *
 * Strict validation: an unknown permission string is a parse ERROR, never
 * silently ignored — a typo'd permission that quietly grants nothing (or
 * everything) is a security footgun.
 */

/**
 * Canonical fixed permissions, `<resource>:<action>`. `net:<host>` is a
 * separate parameterized form handled below. Keep this list the single
 * source of truth; the install consent prompt reads from it.
 */
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

export class PluginPermissionError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(
      `unknown plugin permission '${value}' — must be one of ` +
        `${FIXED_PERMISSIONS.join(', ')}, or net:<host>`,
    );
    this.name = 'PluginPermissionError';
    this.value = value;
  }
}

const FIXED_SET: ReadonlySet<string> = new Set(FIXED_PERMISSIONS);

// RFC-1123-ish host: dot-separated labels, optional `:port`. Wildcard
// `*.example.com` is allowed so a plugin can scope to a subdomain tree.
const NET_HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/i;

/** Validate one permission string, throwing on anything unrecognized. */
export function validatePermission(raw: string): PluginPermission {
  const value = raw.trim();
  if (FIXED_SET.has(value)) return value as FixedPermission;
  if (value.startsWith('net:')) {
    const host = value.slice('net:'.length);
    if (host.length > 0 && host.length <= 255 && NET_HOST_RE.test(host)) {
      return value as `net:${string}`;
    }
    throw new PluginPermissionError(value);
  }
  throw new PluginPermissionError(value);
}

/** Validate + de-duplicate a permission list (order preserved). */
export function validatePermissions(raw: readonly string[]): readonly PluginPermission[] {
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

/**
 * Translate manifest-form capability flags (colon style) into Symphony's
 * `CapabilityFlag` enum (dash style), which the `CapabilityEvaluator`
 * already enforces by tier. The mapping is intentionally lossy in one
 * place: `requires:filesystem-write` has NO tier-gating Symphony flag
 * (plugins are OS-isolated subprocesses; filesystem write is the OS
 * boundary's concern, not a tier floor). It stays recorded in the
 * manifest for install consent but does not gate dispatch. All other
 * flags map 1:1. Order preserved; duplicates collapsed.
 */
export function translateCapabilityFlags(
  flags: readonly ManifestCapabilityFlag[],
): readonly CapabilityFlag[] {
  const out: CapabilityFlag[] = [];
  const seen = new Set<CapabilityFlag>();
  const push = (f: CapabilityFlag): void => {
    if (seen.has(f)) return;
    seen.add(f);
    out.push(f);
  };
  for (const flag of flags) {
    switch (flag) {
      case 'requires:host-browser-control':
        push('requires-host-browser-control');
        break;
      case 'requires:secrets-read':
        push('requires-secrets-read');
        break;
      case 'requires:network-egress':
        push('requires-network-egress-uncontrolled');
        break;
      case 'external-visible':
        push('external-visible');
        break;
      case 'irreversible':
        push('irreversible');
        break;
      case 'requires:filesystem-write':
        // Recorded for consent; no Symphony tier floor (see JSDoc).
        break;
    }
  }
  return out;
}
