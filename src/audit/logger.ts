/**
 * Phase 3R — AuditLogger.
 *
 * Mirrors notifications-dispatcher pattern: disposed flag short-circuits
 * post-shutdown calls; fire-and-forget for the file sink so a stuck
 * filesystem cannot block a sync SQLite write or the call site's
 * dispatch hot-path.
 */

import { sanitize } from '../utils/log-sanitizer.js';
import type { AuditAppendInput, AuditEntry } from '../state/audit-store.js';
import type {
  AuditLogger,
  AuditLoggerAppendOptions,
  AuditLoggerDeps,
} from './types.js';
import { formatAuditLine } from './file-sink.js';

// Audit M1/M2: bound recursion (cycle guard + depth cap) and reject
// non-plain objects. The logger is the documented defense-in-depth
// sanitizer; a future caller passing a live object (cyclic `cause`
// chain, Buffer, Date) must NOT blow the stack or balloon a SQLite row.
const MAX_SANITIZE_DEPTH = 8;

function sanitizeValue(
  value: unknown,
  key: string | null,
  rawKeySet: ReadonlySet<string>,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === 'string') {
    if (key !== null && rawKeySet.has(key)) return value;
    return sanitize(value);
  }
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }
  // Non-plain objects: stringify to a bounded, sanitized scalar rather
  // than walking their (often non-enumerable) internals. `Object.entries`
  // on a Date/Error yields `{}` (data loss) and on a Buffer yields a
  // per-byte map (size explosion) — both worse than a labelled string.
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString();
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }
  if (value instanceof Error) {
    return sanitize(`${value.name}: ${value.message}`);
  }
  if (value instanceof Map || value instanceof Set) {
    return `[${value.constructor.name} size=${value.size}]`;
  }
  if (depth >= MAX_SANITIZE_DEPTH) return '[too deep]';
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((v) => sanitizeValue(v, key, rawKeySet, seen, depth + 1));
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = sanitizeValue(v, k, rawKeySet, seen, depth + 1);
      }
      return out;
    } finally {
      // Allow the same object to appear as a SIBLING (DAG, not cycle)
      // — only the ancestor chain must stay in `seen`.
      seen.delete(value);
    }
  }
  // Functions, symbols, bigint — not JSON-serializable; label them.
  return `[${typeof value}]`;
}

function sanitizePayload(
  payload: Readonly<Record<string, unknown>>,
  rawKeys: readonly string[],
): Record<string, unknown> {
  const rawKeySet = new Set(rawKeys);
  const seen = new WeakSet<object>();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = sanitizeValue(v, k, rawKeySet, seen, 0);
  }
  return out;
}

export function createAuditLogger(deps: AuditLoggerDeps): AuditLogger {
  const now = deps.now ?? ((): string => new Date().toISOString());
  const onError = deps.onError ?? ((): void => undefined);
  let disposed = false;

  function reportError(err: unknown): void {
    onError(err instanceof Error ? err : new Error(String(err)));
  }

  return {
    append(input: AuditAppendInput, opts: AuditLoggerAppendOptions = {}): AuditEntry | null {
      if (disposed) return null;
      const rawKeys = opts.rawKeys ?? [];
      let sanitizedPayload: Record<string, unknown>;
      try {
        sanitizedPayload = sanitizePayload(input.payload ?? {}, rawKeys);
      } catch (err) {
        reportError(err);
        sanitizedPayload = {};
      }

      const stamped: AuditAppendInput = {
        ts: input.ts || now(),
        kind: input.kind,
        severity: input.severity,
        projectId: input.projectId ?? null,
        workerId: input.workerId ?? null,
        taskId: input.taskId ?? null,
        toolName: input.toolName ?? null,
        headline: input.headline,
        payload: sanitizedPayload,
      };

      let entry: AuditEntry;
      try {
        entry = deps.store.append(stamped);
      } catch (err) {
        reportError(err);
        return null;
      }

      if (deps.fileSink !== undefined) {
        const line = formatAuditLine(entry);
        void deps.fileSink.write(line).catch((err: unknown) => {
          reportError(err);
        });
      }

      return entry;
    },

    async shutdown(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (deps.fileSink !== undefined) {
        try {
          await deps.fileSink.shutdown();
        } catch (err) {
          reportError(err);
        }
      }
    },
  };
}
