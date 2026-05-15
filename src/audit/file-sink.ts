/**
 * Phase 3R — Flat-file audit sink (~/.symphony/audit.log).
 *
 * Append-only, line-delimited, mode 0o600 (POSIX; Win32 ACL no-op).
 * Unbounded — flat file is the cold grep / forensic trail; SQLite is
 * the bounded canonical store. Resets do NOT touch this file (3Q
 * rule: "preserves audit log").
 *
 * Write strategy: each `write()` opens for append, writes the line +
 * newline, and closes. Cross-platform safe (POSIX + Win32 both honor
 * append-mode atomicity for single-line writes under ~4 KB). Two
 * Symphony processes writing concurrently may interleave at the line
 * level but never tear within a line.
 *
 * The single-flight serializer is a Promise chain so writes from the
 * SAME process land in submission order even if the OS reorders the
 * underlying open/write/close sequences.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AuditEntry } from '../state/audit-store.js';
import type { AuditFileSink } from './types.js';
import { symphonyDataDir } from '../utils/config.js';

export const AUDIT_LOG_FILENAME = 'audit.log';

export function defaultAuditLogPath(home?: string): string {
  return path.join(symphonyDataDir(home ?? os.homedir()), AUDIT_LOG_FILENAME);
}

function formatField(key: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return ` ${key}=${value}`;
}

/**
 * Format a single audit entry as a flat-file line. ANSI-free; payload
 * NOT included (SQLite has it). Stable column order so `tail | awk`
 * works.
 *
 *   2026-05-14T14:23:01.234Z  worker_spawned  info  project=p1 worker=w-abc task=tk-xyz tool=… "headline"
 */
export function formatAuditLine(entry: AuditEntry): string {
  const headline = entry.headline.replace(/[\r\n]+/g, ' ').trim();
  const head =
    `${entry.ts}  ${entry.kind}  ${entry.severity}` +
    formatField('project', entry.projectId) +
    formatField('worker', entry.workerId) +
    formatField('task', entry.taskId) +
    formatField('tool', entry.toolName);
  // Audit m1 — omit the quoted field entirely for an empty headline
  // rather than emitting a noisy trailing `""` (keeps `tail | awk`
  // column count honest for the no-headline edge).
  return headline.length > 0 ? `${head}  "${headline.replace(/"/g, '\\"')}"` : head;
}

export interface AuditFileSinkOptions {
  readonly filePath?: string;
  /** Test seam — override the underlying writer. */
  readonly writer?: (filePath: string, line: string) => Promise<void>;
}

async function defaultWriter(filePath: string, line: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fsp.open(filePath, 'a', 0o600);
  try {
    await handle.write(`${line}\n`, null, 'utf8');
  } finally {
    await handle.close();
  }
  // POSIX: mode is only honored on file CREATION; chmod ensures
  // pre-existing files (created before 3R landed) get tightened. Win32
  // chmod is a no-op (ACL-based) — documented in known-gotchas.
  try {
    await fsp.chmod(filePath, 0o600);
  } catch {
    // Best-effort; ENOENT race or Win32 ACL fall-through is non-fatal.
  }
}

export function createAuditFileSink(opts: AuditFileSinkOptions = {}): AuditFileSink {
  const filePath = opts.filePath ?? defaultAuditLogPath();
  const writer = opts.writer ?? defaultWriter;
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  return {
    async write(line: string): Promise<void> {
      if (disposed) return;
      const next = chain.then(() => writer(filePath, line));
      // The chain MUST NOT carry rejections — otherwise one failed
      // write poisons every subsequent write. Catch + swallow on the
      // chain; surface the error on the returned promise.
      chain = next.catch(() => undefined);
      await next;
    },
    async shutdown(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Wait for any inflight write to drain before letting the caller
      // proceed to its next teardown step.
      await chain.catch(() => undefined);
    },
  };
}
