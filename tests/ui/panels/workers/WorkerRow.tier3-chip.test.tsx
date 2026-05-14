import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { WorkerRow } from '../../../../src/ui/panels/workers/WorkerRow.js';
import type { WorkerRecordSnapshot } from '../../../../src/orchestrator/worker-registry.js';

/**
 * Phase 3S — per-worker tier chip rendering.
 *
 * The row shows a small `T3` chip ONLY when `worker.autonomyTier === 3`
 * (explicit Confirm-tier elevation). Tier 1 and Tier 2 don't surface a
 * chip — Tier 2 is the orchestrator default (no signal), and Tier 1 is
 * the SQL DEFAULT for pre-3S recovered workers (would surface chips on
 * every row otherwise — noise).
 *
 * The chip color is `theme['warning']` (gold-light / amber) matching
 * the status-bar Tier-3 chip. Consistency means a user scanning the
 * workers panel sees the same color signal as the global tier dial.
 */

function snap(over: Partial<WorkerRecordSnapshot>): WorkerRecordSnapshot {
  return {
    id: 'w-1',
    projectPath: 'C:/projects/alpha',
    worktreePath: 'C:/projects/alpha/.symphony/worktrees/w-1',
    role: 'implementer',
    featureIntent: 'do thing',
    taskDescription: 'do thing',
    autonomyTier: 1,
    dependsOn: [],
    status: 'running',
    createdAt: '2026-05-14T12:00:00.000Z',
    ...over,
  };
}

// theme['warning'] is gold-light `#E5C07B` → `38;2;229;192;123m`.
const WARNING_AMBER = '\x1b[38;2;229;192;123m';

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');
}

describe('<WorkerRow> tier chip (3S)', () => {
  it('renders no T3 chip at Tier 1 (legacy default)', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <WorkerRow
          worker={snap({ autonomyTier: 1 })}
          instrument="Violin"
          selected={false}
          featureIntentDisplay="do thing"
          runtimeDisplay="3m"
        />
      </ThemeProvider>,
    );
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).not.toMatch(/\bT3\b/);
    unmount();
  });

  it('renders no T3 chip at Tier 2 (orchestrator default)', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <WorkerRow
          worker={snap({ autonomyTier: 2 })}
          instrument="Violin"
          selected={false}
          featureIntentDisplay="do thing"
          runtimeDisplay="3m"
        />
      </ThemeProvider>,
    );
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).not.toMatch(/\bT3\b/);
    unmount();
  });

  it('renders the T3 chip at Tier 3 in warning/amber', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <WorkerRow
          worker={snap({ autonomyTier: 3 })}
          instrument="Violin"
          selected={false}
          featureIntentDisplay="do thing"
          runtimeDisplay="3m"
        />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? '';
    const plain = stripAnsi(frame);
    expect(plain).toMatch(/\bT3\b/);
    expect(frame).toContain(WARNING_AMBER);
    unmount();
  });
});
