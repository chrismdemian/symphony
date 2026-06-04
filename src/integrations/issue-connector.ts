/**
 * Phase 8C — the shared contract every issue-tracker connector implements
 * (Linear + GitHub in 8C.1/8C.2; Jira / GitLab / Plain / Forgejo reuse it
 * verbatim later). It mirrors the 8A/8B connector shape so the generic
 * `sync_issues` tool, the `ingestIssueCandidates` reducer, and the writeback
 * fan-out work across all of them.
 *
 * Design decisions carried from 8A/8B:
 *   - The connector returns ALL candidates (open AND terminal); the INGEST
 *     skips terminal ones and counts `skippedDone`. `isTerminal` is the
 *     connector's per-source classification (Linear `state.type`, GitHub
 *     `state === 'closed'`, …). Keeping the terminal-skip in one place keeps
 *     the count honest. (8A/8B parity.)
 *   - Writeback returns a `code` discriminant so failures are observable, never
 *     silent (8B audit-M3). `not-found` = the remote item couldn't be resolved;
 *     `skipped` = an expected no-op (e.g. no `failed` writeback configured).
 *   - The connector is pure source I/O. It never touches Symphony state — task
 *     creation + link persistence are mediated by the tool/server
 *     (single-writer principle).
 */

export interface NormalizedIssue {
  /** Connector-scoped stable id — the external-link key (e.g. Linear issue id,
   *  GitHub `owner/repo#number`). */
  readonly externalId: string;
  /** Issue title → Symphony task description. */
  readonly title: string;
  /** Canonical URL (chat / audit display; stored on the link). */
  readonly url: string | null;
  /** Raw source state vocabulary, for display/debug (Linear state name, …). */
  readonly state: string | null;
  /** The connector's verdict that this issue is already done/closed → ingest
   *  skips it (`skippedDone`). */
  readonly isTerminal: boolean;
  /** Issue body / description (plain text). */
  readonly body: string | null;
  /** Assignee display name / login, if any. */
  readonly assignee: string | null;
  /** Label names. */
  readonly labels: readonly string[];
  /** Routing hint resolved to a Symphony project by the ingest (Linear team /
   *  project name, GitHub `owner/repo`, …). `null` → fall back to the tool's
   *  `project:` arg / active-project cursor. */
  readonly projectValue: string | null;
  /** Normalized integer priority (higher = sooner; default 0). */
  readonly priority: number;
  /** ISO last-updated timestamp, if known. */
  readonly updatedAt: string | null;
}

export interface IssueWritebackResult {
  readonly written: boolean;
  /**
   * - `written`  — the remote item was updated (value carries what).
   * - `skipped`  — an expected no-op (no `failed` writeback configured, etc.).
   * - `not-found`— the remote item / target state couldn't be resolved.
   * - `error`    — an unexpected failure short of a throw.
   */
  readonly code: 'written' | 'skipped' | 'not-found' | 'error';
  /** Human-readable summary of what was written (when `written`). */
  readonly value?: string;
  /** Why nothing was written (for `skipped` / `not-found` / `error`). */
  readonly reason?: string;
}

export interface IssueConnectorHandle {
  /** Connector id used as the `task_external_links.source` value + log prefix. */
  readonly source: string;
  /** Pull open issues (returns terminal ones too — the ingest skips them). */
  fetchOpenIssues(opts?: { readonly limit?: number }): Promise<readonly NormalizedIssue[]>;
  /** Optional text search (not every source supports it server-side). */
  searchIssues?(
    term: string,
    opts?: { readonly limit?: number },
  ): Promise<readonly NormalizedIssue[]>;
  /** Push a terminal task status back to the source issue. */
  writeBackStatus(
    externalId: string,
    status: 'completed' | 'failed',
  ): Promise<IssueWritebackResult>;
  /** Lightweight connection check for `symphony config <name> --status`. */
  checkConnection(): Promise<{ readonly ok: boolean; readonly detail?: string }>;
}
