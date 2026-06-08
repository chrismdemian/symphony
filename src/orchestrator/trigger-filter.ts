/**
 * Phase 8D.4 — trigger filter matching.
 *
 * A TRIGGER automation (8D.2) fires on EVERY new issue/thread of its type by
 * default. `TriggerConfig` scopes it: a fired event must match all configured
 * filters (label OR, assignee exact, branch glob) before the engine claims a
 * run. The config rides the automation's reserved `trigger_config` column
 * (JSON); the trigger engine parses it once per automation per poll and gates
 * the fresh-event loop through {@link matchesTriggerFilters}.
 *
 * Ported from emdash `AutomationsService.matchesTriggerFilters` (:575-605) with
 * one deliberate divergence for Symphony's issue-only sources — see the branch
 * note on {@link matchesTriggerFilters}.
 */

import type { RawTriggerEvent } from './automation-trigger-source.js';

/**
 * Event-scoping filters for a TRIGGER automation. All present filters must
 * match (AND across filter kinds); `labelFilter` is OR within itself. An
 * absent / empty config matches every event.
 */
export interface TriggerConfig {
  /** Match only events carrying at least one of these labels (case-insensitive OR). */
  readonly labelFilter?: readonly string[];
  /**
   * Match only events on a branch matching this glob (`*` wildcard), e.g.
   * `"feature/*"`. Applies ONLY to branch-bearing sources (PRs); issue
   * triggers — every Symphony source today — have no branch and IGNORE it.
   */
  readonly branchFilter?: string;
  /** Match only events assigned to this user (case-insensitive exact). */
  readonly assigneeFilter?: string;
}

/**
 * Parse the automation's `trigger_config` JSON into a normalized
 * {@link TriggerConfig}. Returns `null` (= no filtering) when the column is
 * null, unparseable, not an object, or carries no usable filter field. Invalid
 * individual fields are dropped rather than failing the whole config.
 *
 * Fail-OPEN by design (matches emdash): an unparseable config means the trigger
 * fires on everything, never silently nothing — a scoped trigger that suddenly
 * matches NOTHING is a worse, harder-to-diagnose failure than one that's
 * briefly too broad. A malformed config is logged so it's visible.
 */
export function parseTriggerConfig(
  json: string | null,
  log?: (level: 'warn', message: string) => void,
): TriggerConfig | null {
  if (json === null) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    log?.('warn', `trigger_config is not valid JSON; firing unfiltered: ${json.slice(0, 120)}`);
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    log?.('warn', 'trigger_config is not an object; firing unfiltered');
    return null;
  }
  const raw = obj as Record<string, unknown>;
  const config: {
    labelFilter?: readonly string[];
    branchFilter?: string;
    assigneeFilter?: string;
  } = {};

  if (Array.isArray(raw.labelFilter)) {
    const labels = raw.labelFilter.filter(
      (l): l is string => typeof l === 'string' && l.trim().length > 0,
    );
    if (labels.length > 0) config.labelFilter = labels;
  }
  if (typeof raw.branchFilter === 'string' && raw.branchFilter.trim().length > 0) {
    config.branchFilter = raw.branchFilter;
  }
  if (typeof raw.assigneeFilter === 'string' && raw.assigneeFilter.trim().length > 0) {
    config.assigneeFilter = raw.assigneeFilter;
  }

  return config.labelFilter !== undefined ||
    config.branchFilter !== undefined ||
    config.assigneeFilter !== undefined
    ? config
    : null;
}

/** Filter inputs from the CLI (`--label/--assignee/--branch`) or MCP tool. */
export interface TriggerFilterFlags {
  readonly labels?: readonly string[];
  readonly assignee?: string;
  readonly branch?: string;
}

/**
 * Build the `trigger_config` JSON string from filter flags, or `null` when no
 * usable filter is given. Shared by the CLI and the MCP tool so both paths
 * produce identical config (mirrors the schedule builder in
 * `automation-schedule.ts`).
 */
export function buildTriggerConfigJson(flags: TriggerFilterFlags): string | null {
  const config: {
    labelFilter?: string[];
    assigneeFilter?: string;
    branchFilter?: string;
  } = {};
  if (flags.labels !== undefined) {
    const labels = flags.labels.map((l) => l.trim()).filter((l) => l.length > 0);
    if (labels.length > 0) config.labelFilter = labels;
  }
  if (flags.assignee !== undefined && flags.assignee.trim().length > 0) {
    config.assigneeFilter = flags.assignee.trim();
  }
  if (flags.branch !== undefined && flags.branch.trim().length > 0) {
    config.branchFilter = flags.branch.trim();
  }
  return Object.keys(config).length > 0 ? JSON.stringify(config) : null;
}

/** One-line human summary of a parsed config, e.g. `label:bug,urgent assignee:chris`. Empty string for null. */
export function describeTriggerFilters(config: TriggerConfig | null): string {
  if (config === null) return '';
  const parts: string[] = [];
  if (config.labelFilter !== undefined && config.labelFilter.length > 0) {
    parts.push(`label:${config.labelFilter.join(',')}`);
  }
  // Guard non-empty even though parseTriggerConfig already drops blanks — keeps
  // the helper honest if a future caller hand-builds a TriggerConfig.
  if (config.assigneeFilter !== undefined && config.assigneeFilter.length > 0) {
    parts.push(`assignee:${config.assigneeFilter}`);
  }
  if (config.branchFilter !== undefined && config.branchFilter.length > 0) {
    parts.push(`branch:${config.branchFilter}`);
  }
  return parts.join(' ');
}

/** Convert a glob (only `*` is special) to an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  // Escape every regex metachar, THEN turn the (now-escaped) `*` back into `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * True if `event` passes every configured filter in `config`. A `null` config
 * (no filters) always matches.
 *
 * - **labelFilter**: the event must carry at least one of the configured labels
 *   (case-insensitive). An event with no labels never matches a label filter.
 * - **assigneeFilter**: the event's assignee must equal the configured value
 *   (case-insensitive). An unassigned event never matches.
 * - **branchFilter**: glob-matched against `event.branch`. **Divergence from
 *   emdash:** every Symphony trigger source today is issue-based and carries no
 *   `branch`. Rather than suppress all issue events when a stray branch filter
 *   is set (emdash returns false on a missing branch — it has PR sources), we
 *   SKIP the branch check when the event has no branch. The filter activates
 *   only once branch-bearing (PR) sources land.
 */
export function matchesTriggerFilters(
  event: RawTriggerEvent,
  config: TriggerConfig | null,
): boolean {
  if (config === null) return true;

  if (config.labelFilter !== undefined && config.labelFilter.length > 0) {
    if (event.labels.length === 0) return false;
    const lowerLabels = event.labels.map((l) => l.toLowerCase());
    const hasMatch = config.labelFilter.some((f) => lowerLabels.includes(f.toLowerCase()));
    if (!hasMatch) return false;
  }

  if (config.assigneeFilter !== undefined) {
    if (event.assignee === null) return false;
    if (event.assignee.toLowerCase() !== config.assigneeFilter.toLowerCase()) return false;
  }

  if (config.branchFilter !== undefined) {
    const branch = event.branch;
    // Only enforce when the source actually carries a branch (PRs). Issue
    // sources (branch undefined/null) ignore the filter — see the JSDoc.
    if (typeof branch === 'string' && branch.length > 0) {
      const pattern = config.branchFilter;
      if (pattern.includes('*')) {
        if (!globToRegExp(pattern).test(branch)) return false;
      } else if (branch !== pattern) {
        return false;
      }
    }
  }

  return true;
}
