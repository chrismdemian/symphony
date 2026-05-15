/**
 * Phase 3R — AuditLogger type surface.
 *
 * The logger is a thin sanitize + dual-sink wrapper over `AuditStore`
 * (sync SQLite writes; canonical source of truth) and `AuditFileSink`
 * (append-only ~/.symphony/audit.log; cold grep / forensic trail).
 *
 * Sanitization rules (defense in depth — the architecture.md mandate
 * also requires call sites to be careful):
 *
 *   - Every string value in `payload` is passed through `sanitize()`
 *     unless its key is listed in `rawKeys`. Use `rawKeys` for SHAs,
 *     project / worker / task ids, tier numbers, scope/capability names
 *     — public protocol metadata that loses meaning when masked.
 *   - `headline` is NOT sanitized — it's caller-formatted display text.
 *     Callers compose using project names + worker names + intent text,
 *     all of which are user-chosen labels (no PII concern).
 *   - Nested object values are recursively sanitized; arrays preserve
 *     length and element-wise sanitize. Numbers, booleans, null
 *     pass through unchanged.
 */

import type {
  AuditAppendInput,
  AuditEntry,
  AuditStore,
} from '../state/audit-store.js';

export interface AuditFileSink {
  /**
   * Append one line to the audit log file. Resolves on flush success;
   * the AuditLogger does NOT await this — errors surface through
   * `onError`.
   */
  write(line: string): Promise<void>;
  /** Flush any in-flight write and release file resources. */
  shutdown(): Promise<void>;
}

export interface AuditLoggerDeps {
  /** Required — the SQLite store. */
  readonly store: AuditStore;
  /**
   * Optional — file sink mirror. When omitted (e.g. tests), the logger
   * persists to SQLite only.
   */
  readonly fileSink?: AuditFileSink;
  /** Test seam — defaults to `() => new Date().toISOString()`. */
  readonly now?: () => string;
  /** Defaults to a no-op. Receives sanitize/store/file failures. */
  readonly onError?: (err: Error) => void;
}

export interface AuditLoggerAppendOptions {
  /**
   * Payload keys whose values should NOT be sanitized. Use for SHAs,
   * ids, tier numbers, scope/capability names — public protocol
   * metadata. Default: empty (everything string-typed gets sanitized).
   */
  readonly rawKeys?: readonly string[];
}

export interface AuditLogger {
  /**
   * Append an audit entry. Sanitizes the payload per `rawKeys`,
   * persists to SQLite synchronously, then fires the file sink write
   * asynchronously. Returns the stored entry.
   *
   * If the logger is disposed, returns `null` (no-op short-circuit
   * mirrors the notifications dispatcher pattern).
   */
  append(input: AuditAppendInput, opts?: AuditLoggerAppendOptions): AuditEntry | null;
  shutdown(): Promise<void>;
}
