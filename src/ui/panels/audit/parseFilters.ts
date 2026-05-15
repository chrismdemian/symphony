/**
 * Phase 3R — `/log` filter parser.
 *
 * Parses the flag string after `/log` (or typed into the panel's filter
 * row) into a structured filter. Pure + deterministic: `nowMs` is an
 * argument so `--last` resolves to a fixed `sinceTs` in tests.
 *
 * Syntax:
 *   --project <name>      raw name; the panel resolves it to a projectId
 *   --last <duration>     1h / 30m / 2h30m / 7d / 2w  (see duration.ts)
 *   --type <a,b,c>        AuditKind values or category aliases
 *   --severity <s> | -s   info | warn | error
 *   --worker <id>         exact worker id
 *   --limit <n>           1..1000 (clamped by the store)
 *
 * Unknown flags / unparseable values surface in `errors` (rendered as a
 * muted warning row) but never throw — a typo shouldn't blank the log.
 */

import { AUDIT_KINDS, type AuditKind, type AuditSeverity } from '../../../state/audit-store.js';
import { parseDuration } from '../../../audit/duration.js';

const KIND_SET: ReadonlySet<string> = new Set<string>(AUDIT_KINDS);

/** Category aliases → concrete AuditKind sets. */
const KIND_ALIASES: Record<string, readonly AuditKind[]> = {
  worker: [
    'worker_spawned',
    'worker_completed',
    'worker_failed',
    'worker_crashed',
    'worker_timeout',
    'worker_killed',
    'worker_interrupted',
  ],
  workers: [
    'worker_spawned',
    'worker_completed',
    'worker_failed',
    'worker_crashed',
    'worker_timeout',
    'worker_killed',
    'worker_interrupted',
  ],
  tool: ['tool_called', 'tool_denied', 'tool_error'],
  tools: ['tool_called', 'tool_denied', 'tool_error'],
  merge: ['merge_performed', 'merge_declined', 'merge_failed', 'merge_ready'],
  merges: ['merge_performed', 'merge_declined', 'merge_failed', 'merge_ready'],
  question: ['question_asked', 'question_answered'],
  questions: ['question_asked', 'question_answered'],
  mode: ['tier_changed', 'model_mode_changed', 'away_mode_changed'],
  spawn: ['worker_spawned'],
  errors: ['error', 'tool_error', 'worker_failed', 'worker_crashed'],
};

export interface ParsedLogFilter {
  readonly projectName?: string;
  readonly sinceTs?: string;
  readonly kinds?: readonly AuditKind[];
  readonly severity?: AuditSeverity;
  readonly workerId?: string;
  readonly limit?: number;
  readonly errors: readonly string[];
}

interface MutableFilter {
  projectName?: string;
  sinceTs?: string;
  kinds?: AuditKind[];
  severity?: AuditSeverity;
  workerId?: string;
  limit?: number;
  errors: string[];
}

function resolveKinds(raw: string): { kinds: AuditKind[]; bad: string[] } {
  const kinds = new Set<AuditKind>();
  const bad: string[] = [];
  for (const tokenRaw of raw.split(',')) {
    const token = tokenRaw.trim().toLowerCase();
    if (token.length === 0) continue;
    if (KIND_SET.has(token)) {
      kinds.add(token as AuditKind);
      continue;
    }
    const alias = KIND_ALIASES[token];
    if (alias !== undefined) {
      for (const k of alias) kinds.add(k);
      continue;
    }
    bad.push(token);
  }
  return { kinds: [...kinds], bad };
}

/**
 * Tokenize a flag string respecting nothing fancy — whitespace splits,
 * flags start with `-`. Values are the run of non-flag tokens after a
 * flag. `--type a, b` and `--type a,b` both work because we re-join the
 * value run before comma-splitting.
 */
function tokenize(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function parseLogFilter(
  input: string,
  nowMs: number = Date.now(),
): ParsedLogFilter {
  const out: MutableFilter = { errors: [] };
  const tokens = tokenize(input);
  let i = 0;

  function takeValue(flag: string): string | null {
    // Collect tokens until the next flag (so `--type a, b` works).
    const parts: string[] = [];
    while (i < tokens.length && !tokens[i]!.startsWith('-')) {
      parts.push(tokens[i]!);
      i += 1;
    }
    if (parts.length === 0) {
      out.errors.push(`${flag} expects a value`);
      return null;
    }
    return parts.join(' ');
  }

  while (i < tokens.length) {
    const tok = tokens[i]!;
    i += 1;
    switch (tok) {
      case '--project':
      case '-p': {
        const v = takeValue(tok);
        if (v !== null) out.projectName = v;
        break;
      }
      case '--last':
      case '-l': {
        const v = takeValue(tok);
        if (v !== null) {
          const ms = parseDuration(v.replace(/\s+/g, ''));
          if (ms === null) {
            out.errors.push(`invalid --last duration: "${v}"`);
          } else {
            out.sinceTs = new Date(nowMs - ms).toISOString();
          }
        }
        break;
      }
      case '--type':
      case '-t': {
        const v = takeValue(tok);
        if (v !== null) {
          const { kinds, bad } = resolveKinds(v);
          if (kinds.length > 0) out.kinds = kinds;
          if (bad.length > 0) out.errors.push(`unknown --type: ${bad.join(', ')}`);
        }
        break;
      }
      case '--severity':
      case '-s': {
        const v = takeValue(tok);
        if (v !== null) {
          const s = v.trim().toLowerCase();
          if (s === 'info' || s === 'warn' || s === 'error') {
            out.severity = s;
          } else {
            out.errors.push(`invalid --severity: "${v}" (info|warn|error)`);
          }
        }
        break;
      }
      case '--worker':
      case '-w': {
        const v = takeValue(tok);
        if (v !== null) out.workerId = v;
        break;
      }
      case '--limit':
      case '-n': {
        const v = takeValue(tok);
        if (v !== null) {
          const n = Number.parseInt(v, 10);
          if (!Number.isFinite(n) || n <= 0) {
            out.errors.push(`invalid --limit: "${v}"`);
          } else {
            out.limit = n;
          }
        }
        break;
      }
      default:
        out.errors.push(`unknown flag: ${tok}`);
        // Skip any value tokens belonging to the bad flag.
        while (i < tokens.length && !tokens[i]!.startsWith('-')) i += 1;
        break;
    }
  }

  return {
    ...(out.projectName !== undefined ? { projectName: out.projectName } : {}),
    ...(out.sinceTs !== undefined ? { sinceTs: out.sinceTs } : {}),
    ...(out.kinds !== undefined ? { kinds: out.kinds } : {}),
    ...(out.severity !== undefined ? { severity: out.severity } : {}),
    ...(out.workerId !== undefined ? { workerId: out.workerId } : {}),
    ...(out.limit !== undefined ? { limit: out.limit } : {}),
    errors: out.errors,
  };
}
