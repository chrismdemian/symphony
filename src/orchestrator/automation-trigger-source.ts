/**
 * Phase 8D.2 — trigger sources: the adapter from a Phase-8C issue connector
 * to the trigger engine's event stream.
 *
 * Each {@link TriggerSource} serves one `trigger_type` (`github_issue`,
 * `linear_issue`, …) and returns the CURRENT candidate events (open issues).
 * The trigger engine (`automation-trigger-engine.ts`) diffs successive polls
 * against a per-automation known-id set to detect genuinely-new events.
 *
 * The connectors are already constructed once in `server.ts` (Process B);
 * this wraps each `IssueConnectorHandle` so the engine never imports the
 * connector internals. The GitHub connector's in-memory ETag cache makes
 * repeat single-page polls nearly free — pass a stable `limit <= 100` so the
 * cached page-1 URL key is hit every cycle (see `github-client.ts`).
 */

import type { IssueConnectorHandle, NormalizedIssue } from '../integrations/issue-connector.js';

/**
 * A normalized firing event. The `id` is the stable dedup key; the rest is
 * carried into the run log's `trigger_event` JSON for the injector to enrich
 * the Maestro turn (8D.2 minimal: type + title + url; richer formatting +
 * label/assignee FILTER scoping is 8D.4 — `labels`/`assignee` are surfaced
 * here now so the 8D.4 filter layer has the data without a re-poll).
 */
export interface RawTriggerEvent {
  /** Stable dedup id, namespaced by source: `<source>:<externalId>`. */
  readonly id: string;
  /** Issue title — the headline in the enriched prompt. */
  readonly title: string;
  /** Canonical URL, if any. */
  readonly url: string | null;
  /** Human display type, e.g. `"GitHub issue"`. */
  readonly type: string;
  /** One-line extra context (the connector-scoped external id). */
  readonly extra?: string;
  /** Label names (for 8D.4 label filtering). */
  readonly labels: readonly string[];
  /** Assignee display name / login (for 8D.4 assignee filtering). */
  readonly assignee: string | null;
}

/**
 * The trigger types Symphony supports — one per Phase-8C issue connector. A
 * trigger automation may name one of these regardless of whether its connector
 * is currently configured; an unconfigured type simply never fires (the engine
 * has no source for it) until `symphony config <connector>` activates it.
 */
export const KNOWN_TRIGGER_TYPES = [
  'github_issue',
  'linear_issue',
  'jira_issue',
  'gitlab_issue',
  'plain_thread',
  'forgejo_issue',
] as const;

export type KnownTriggerType = (typeof KNOWN_TRIGGER_TYPES)[number];

export interface TriggerSource {
  /** The automation `trigger_type` this source serves. */
  readonly triggerType: string;
  /**
   * Fetch the current candidate events. MUST NOT throw — a fetch failure
   * (network / auth) resolves to `[]` so one flaky source never aborts the
   * whole poll cycle (emdash `fetchRawEvents` swallow-and-return-`[]`).
   */
  fetchEvents(): Promise<readonly RawTriggerEvent[]>;
}

/**
 * Default per-poll fetch size. Kept `<= 100` so the GitHub connector's
 * single-page ETag cache applies (304 → cached, no rate-limit charge). A
 * trigger only needs to see the newest issues each cycle; a large backlog is
 * seeded once on first poll and never re-fired.
 */
export const ISSUE_TRIGGER_FETCH_LIMIT = 50;

export interface IssueTriggerSourceDeps {
  readonly connector: IssueConnectorHandle;
  /** The automation `trigger_type` (e.g. `'github_issue'`). */
  readonly triggerType: string;
  /** Human display type for the enriched prompt (e.g. `'GitHub issue'`). */
  readonly displayType: string;
  /** Override the fetch limit (tests). Defaults to {@link ISSUE_TRIGGER_FETCH_LIMIT}. */
  readonly limit?: number;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** Map a {@link NormalizedIssue} to a {@link RawTriggerEvent}. */
function issueToEvent(
  issue: NormalizedIssue,
  source: string,
  displayType: string,
): RawTriggerEvent {
  return {
    id: `${source}:${issue.externalId}`,
    title: issue.title,
    url: issue.url,
    type: displayType,
    extra: issue.externalId,
    labels: issue.labels,
    assignee: issue.assignee,
  };
}

/**
 * Wrap an {@link IssueConnectorHandle} as a {@link TriggerSource}. Terminal
 * (closed/done) issues are filtered out — a trigger fires on actionable work,
 * never on an already-closed item that briefly appears in a fetch.
 */
export function makeIssueTriggerSource(deps: IssueTriggerSourceDeps): TriggerSource {
  const limit = deps.limit ?? ISSUE_TRIGGER_FETCH_LIMIT;
  return {
    triggerType: deps.triggerType,
    async fetchEvents(): Promise<readonly RawTriggerEvent[]> {
      let issues: readonly NormalizedIssue[];
      try {
        issues = await deps.connector.fetchOpenIssues({ limit });
      } catch (err) {
        deps.log?.(
          'warn',
          `${deps.triggerType} fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
      return issues
        .filter((i) => !i.isTerminal)
        .map((i) => issueToEvent(i, deps.connector.source, deps.displayType));
    },
  };
}
