import type { ExternalLinkStore } from '../state/external-link-store.js';
import type { TaskSnapshot } from '../state/types.js';
import type { IssueConnectorHandle } from '../integrations/issue-connector.js';

/**
 * Phase 8C — build the terminal-status writeback hook for an issue connector.
 *
 * Lifts the Notion/Obsidian writeback-ref body (server.ts) into one reusable
 * factory: when a task with a `source` external link reaches a terminal status,
 * push that status back to the source issue. Fire-and-forget (the connector's
 * own throttle serializes concurrent completions); failures are logged, never
 * thrown into the event bus.
 *
 * Observability (8B audit-M3): logs on `code !== 'skipped'` so a `not-found`
 * (the remote issue couldn't be resolved) or `error` surfaces, while expected
 * no-ops (no `failed` writeback configured) stay quiet.
 *
 * The hook bypasses the `external-visible` Tier-2 floor by design — it's a
 * host-initiated reaction to observed state, and the link only exists because a
 * Tier-≥2 `sync_*` created it (accepted, 8A audit-m1).
 */
export function makeIssueWritebackRef(deps: {
  readonly connector: IssueConnectorHandle;
  readonly source: string;
  readonly externalLinkStore: ExternalLinkStore;
  readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;
}): (snapshot: TaskSnapshot) => void {
  return (snapshot: TaskSnapshot): void => {
    if (snapshot.status !== 'completed' && snapshot.status !== 'failed') return;
    const link = deps.externalLinkStore
      .listByTaskId(snapshot.id)
      .find((l) => l.source === deps.source);
    if (link === undefined) return;
    void deps.connector.writeBackStatus(link.externalId, snapshot.status).then(
      (result) => {
        if (result.written) {
          deps.log('info', `issue ${link.externalId} → ${result.value ?? snapshot.status}`);
        } else if (result.code !== 'skipped') {
          // not-found (the remote issue/state couldn't be resolved) or error:
          // surface it, never fail silently (8B audit-M3).
          deps.log('warn', `writeback skipped for ${link.externalId}: ${result.reason ?? result.code}`);
        }
      },
      (err: unknown) => {
        deps.log(
          'warn',
          `writeback failed for ${link.externalId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
  };
}
