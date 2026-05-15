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

function sanitizeValue(
  value: unknown,
  key: string | null,
  rawKeySet: ReadonlySet<string>,
): unknown {
  if (typeof value === 'string') {
    if (key !== null && rawKeySet.has(key)) return value;
    return sanitize(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, key, rawKeySet));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeValue(v, k, rawKeySet);
    }
    return out;
  }
  return value;
}

function sanitizePayload(
  payload: Readonly<Record<string, unknown>>,
  rawKeys: readonly string[],
): Record<string, unknown> {
  const rawKeySet = new Set(rawKeys);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = sanitizeValue(v, k, rawKeySet);
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
