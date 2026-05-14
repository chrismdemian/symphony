import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { StatusBar } from '../../src/ui/layout/StatusBar.js';
import type { ProjectSnapshot } from '../../src/projects/types.js';
import type { WorkerRecordSnapshot } from '../../src/orchestrator/worker-registry.js';

const baseProject: ProjectSnapshot = {
  id: 'p1',
  name: 'MathScrabble',
  path: 'C:/foo',
  createdAt: '2026-04-29T00:00:00.000Z',
};

const baseWorker = (status: WorkerRecordSnapshot['status']): WorkerRecordSnapshot => ({
  id: `w-${status}`,
  projectPath: 'C:/foo',
  worktreePath: 'C:/foo/.symphony/worktrees/x',
  role: 'implementer',
  featureIntent: 'feat-x',
  taskDescription: 'task',
  autonomyTier: 1,
  dependsOn: [],
  status,
  createdAt: '2026-04-29T00:00:00.000Z',
});

function renderStatusBar(props: React.ComponentProps<typeof StatusBar>) {
  const result = render(
    <ThemeProvider>
      <StatusBar {...props} />
    </ThemeProvider>,
  );
  // Phase 3B.3: tests/setup.ts forces chalk.level=3 globally so
  // gradient-string emits ANSI in non-TTY test envs. Existing
  // text-content assertions need to strip escapes before regex / contain
  // checks. Wrapper preserves original signature, augments with a
  // stripped-frame helper.
  const stripAnsi = (s: string): string =>
    // eslint-disable-next-line no-control-regex
    s.replace(/\x1b\[[\d;]*[a-zA-Z]/g, '');
  return {
    ...result,
    lastFrame: () => stripAnsi(result.lastFrame() ?? ''),
  };
}

describe('<StatusBar>', () => {
  it('renders Symphony brand + version', () => {
    const { lastFrame } = renderStatusBar({
      version: '0.0.0',
      mode: 'plan',
      projects: [],
      workers: [],
      sessionId: null,
    });
    expect(lastFrame()).toContain('Symphony');
    expect(lastFrame()).toContain('v0.0.0');
  });

  it('formats mode in uppercase', () => {
    const { lastFrame } = renderStatusBar({
      version: '0.0.0',
      mode: 'plan',
      projects: [],
      workers: [],
      sessionId: null,
    });
    expect(lastFrame()).toContain('Mode:');
    expect(lastFrame()).toContain('PLAN');
  });

  it('shows em-dash for null mode', () => {
    const { lastFrame } = renderStatusBar({
      version: '0.0.0',
      mode: null,
      projects: [],
      workers: [],
      sessionId: null,
    });
    expect(lastFrame()).toContain('—');
  });

  it('counts only non-terminal workers', () => {
    const { lastFrame } = renderStatusBar({
      version: '0.0.0',
      mode: 'act',
      projects: [],
      workers: [
        baseWorker('running'),
        baseWorker('spawning'),
        baseWorker('completed'),
        baseWorker('failed'),
        baseWorker('killed'),
        baseWorker('crashed'),
        baseWorker('timeout'),
      ],
      sessionId: null,
    });
    expect(lastFrame()).toMatch(/Workers:\s*2/);
  });

  it('shows (none) when zero projects registered', () => {
    const { lastFrame } = renderStatusBar({
      version: '0.0.0',
      mode: 'plan',
      projects: [],
      workers: [],
      sessionId: null,
    });
    expect(lastFrame()).toContain('(none)');
  });

  it('shows project name + overflow count when multiple', () => {
    const { lastFrame } = renderStatusBar({
      version: '0.0.0',
      mode: 'plan',
      projects: [
        baseProject,
        { ...baseProject, id: 'p2', name: 'CRE' },
        { ...baseProject, id: 'p3', name: 'Other' },
      ],
      workers: [],
      sessionId: null,
    });
    expect(lastFrame()).toContain('MathScrabble');
    expect(lastFrame()).toContain('(+2)');
  });

  it('renders short session id when provided', () => {
    const { lastFrame } = renderStatusBar({
      version: '0.0.0',
      mode: 'plan',
      projects: [],
      workers: [],
      sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    });
    expect(lastFrame()).toContain('Session:');
    expect(lastFrame()).toContain('a1b2c3d4');
    expect(lastFrame()).not.toContain('a1b2c3d4-e5f6'); // truncated to 8
  });

  it('omits session field when null', () => {
    const { lastFrame } = renderStatusBar({
      version: '0.0.0',
      mode: 'plan',
      projects: [],
      workers: [],
      sessionId: null,
    });
    expect(lastFrame()).not.toContain('Session:');
  });

  it('renders Q: 0 cell when questionsCount is omitted', () => {
    const { lastFrame } = renderStatusBar({
      version: '0.0.0',
      mode: 'plan',
      projects: [],
      workers: [],
      sessionId: null,
    });
    expect(lastFrame()).toMatch(/Q:\s*0/);
  });

  it('renders Q: <n> when questionsCount is positive', () => {
    const { lastFrame } = renderStatusBar({
      version: '0.0.0',
      mode: 'plan',
      projects: [],
      workers: [],
      sessionId: null,
      questionsCount: 3,
      blockingCount: 1,
    });
    expect(lastFrame()).toMatch(/Q:\s*3/);
  });

  it('paints Q-cell red for blocking via truecolor escape', () => {
    // Don't use the stripped-frame helper here — color escapes are the
    // assertion.
    const result = render(
      <ThemeProvider>
        <StatusBar
          version="0.0.0"
          mode="act"
          projects={[]}
          workers={[]}
          sessionId={null}
          questionsCount={2}
          blockingCount={2}
        />
      </ThemeProvider>,
    );
    const frame = result.lastFrame() ?? '';
    // theme['error'] = #E06C75 → truecolor escape:
    expect(frame).toContain('\x1b[38;2;224;108;117m');
    // eslint-disable-next-line no-control-regex
    expect(frame).toMatch(/Q:\s*\x1b\[38;2;224;108;117m2/);
  });

  it('paints Q-cell gold-light for advisory-only via truecolor escape', () => {
    const result = render(
      <ThemeProvider>
        <StatusBar
          version="0.0.0"
          mode="act"
          projects={[]}
          workers={[]}
          sessionId={null}
          questionsCount={1}
          blockingCount={0}
        />
      </ThemeProvider>,
    );
    const frame = result.lastFrame() ?? '';
    // theme['warning'] = goldLight #E5C07B → truecolor escape:
    expect(frame).toContain('\x1b[38;2;229;192;123m');
  });

  describe('Phase 3M — Away Mode segment', () => {
    it('omits the Away Mode segment when awayMode is false', () => {
      const { lastFrame } = renderStatusBar({
        version: '0.0.0',
        mode: 'plan',
        projects: [],
        workers: [],
        sessionId: null,
      });
      expect(lastFrame()).not.toContain('Away Mode');
    });

    it('renders the Away Mode segment with done/pending/questions counts', () => {
      const { lastFrame } = renderStatusBar({
        version: '0.0.0',
        mode: 'act',
        projects: [],
        workers: [
          baseWorker('completed'),
          baseWorker('completed'),
          baseWorker('running'),
          baseWorker('failed'),
        ],
        sessionId: null,
        questionsCount: 3,
        awayMode: true,
        pendingQueueCount: 2,
      });
      // ink-testing-library wraps wide rows across lines AND the new 3S
      // tier chip interleaves wrapped content positionally — Ink lays
      // out the chip's tokens between "3" and "questions" under narrow
      // widths. Tests assert presence-of-tokens, not adjacency. The
      // positional invariant (chip after Session) lives in the 3S
      // visual harness (rendered at 120 cols).
      const normalized = lastFrame().replace(/\s+/g, ' ');
      expect(normalized).toContain('Away Mode');
      // Done counts only `completed` status (PLAN.md §3M:1320 intent —
      // successes vs other terminal states routed separately).
      expect(normalized).toContain('2 done');
      expect(normalized).toContain('2 pending');
      expect(normalized).toContain('3');
      expect(normalized).toContain('questions');
      expect(normalized).toContain('queued');
    });

    it('uses singular "question" when count is 1', () => {
      const { lastFrame } = renderStatusBar({
        version: '0.0.0',
        mode: 'act',
        projects: [],
        workers: [],
        sessionId: null,
        questionsCount: 1,
        awayMode: true,
        pendingQueueCount: 0,
      });
      const normalized = lastFrame().replace(/\s+/g, ' ');
      // Pluralization boundary: "question " (singular + trailing space)
      // appears, but "questions" (plural) must not. Whitespace-collapsed
      // string means the trailing space is preserved as one space; chip
      // interleaving (3S) doesn't change the pluralization token itself.
      expect(normalized).toMatch(/\bquestion\b/);
      expect(normalized).not.toMatch(/\bquestions\b/);
      expect(normalized).toContain('queued');
    });

    it('paints Away Mode segment with the muted-gray truecolor escape', () => {
      const result = render(
        <ThemeProvider>
          <StatusBar
            version="0.0.0"
            mode="act"
            projects={[]}
            workers={[]}
            sessionId={null}
            awayMode={true}
            pendingQueueCount={0}
            questionsCount={0}
          />
        </ThemeProvider>,
      );
      const frame = result.lastFrame() ?? '';
      // theme['textMuted'] = #888888 → truecolor escape. PLAN.md §3M
      // calls for the muted-gray text token to signal away state.
      expect(frame).toContain('\x1b[38;2;136;136;136m');
      // The Away label is within a muted-gray run (no accent break).
      // eslint-disable-next-line no-control-regex
      expect(frame).toMatch(/\x1b\[38;2;136;136;136m[^\x1b]*Away Mode/);
    });

    // Note: a "Away segment renders after Project, before Session"
    // positional assertion belongs in the visual harness — ink-testing-
    // library's default terminal width wraps the full-segment bar in
    // ways that interleave continuations and make `indexOf` ordering
    // unreliable. The 3m visual frames (commit 3) render at 120 cols
    // and exercise the order directly.
  });

  describe('session totals segment (Phase 3N.2)', () => {
    it('omits the segment when sessionTotals is undefined', () => {
      const { lastFrame } = renderStatusBar({
        version: '0.0.0',
        mode: 'act',
        projects: [],
        workers: [],
        sessionId: null,
      });
      expect(lastFrame()).not.toContain('↑');
    });

    it('omits the segment when both totals are 0 (splash / pre-first-spawn)', () => {
      const { lastFrame } = renderStatusBar({
        version: '0.0.0',
        mode: 'act',
        projects: [],
        workers: [],
        sessionId: null,
        sessionTotals: {
          totalTokens: 0,
          totalCostUsd: 0,
          workerCount: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
      expect(lastFrame()).not.toContain('↑');
    });

    it('renders the segment once any tokens have been billed', () => {
      const { lastFrame } = renderStatusBar({
        version: '0.0.0',
        mode: 'act',
        projects: [],
        workers: [],
        sessionId: null,
        sessionTotals: {
          totalTokens: 47_120,
          totalCostUsd: 0.12,
          workerCount: 3,
          cacheReadTokens: 30_000,
          cacheWriteTokens: 0,
        },
      });
      const frame = lastFrame();
      expect(frame).toContain('↑');
      expect(frame).toContain('47K');
      expect(frame).toContain('$0.12');
    });

    it('renders the segment when cost > 0 but tokens are 0 (cost-only worker)', () => {
      const { lastFrame } = renderStatusBar({
        version: '0.0.0',
        mode: 'act',
        projects: [],
        workers: [],
        sessionId: null,
        sessionTotals: {
          totalTokens: 0,
          totalCostUsd: 0.0042,
          workerCount: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
      const frame = lastFrame();
      expect(frame).toContain('↑');
      // <$0.01 → 4 decimals (matches completion-summarizer precedent)
      expect(frame).toContain('$0.0042');
    });

    it('paints the values with the violet accent truecolor escape', () => {
      const result = render(
        <ThemeProvider>
          <StatusBar
            version="0.0.0"
            mode="act"
            projects={[]}
            workers={[]}
            sessionId={null}
            sessionTotals={{
              totalTokens: 1_200_000,
              totalCostUsd: 4.25,
              workerCount: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            }}
          />
        </ThemeProvider>,
      );
      const frame = result.lastFrame() ?? '';
      // theme['accent'] = violet #7C6FEB → truecolor escape
      expect(frame).toContain('\x1b[38;2;124;111;235m');
      // Strip escapes for content checks.
      const plain = frame.replace(
        // eslint-disable-next-line no-control-regex
        /\x1b\[[\d;]*[a-zA-Z]/g,
        '',
      );
      expect(plain).toContain('1.2M');
      expect(plain).toContain('$4.25');
    });
  });

  // Phase 3S — autonomy tier chip rendering.

  describe('autonomy tier chip (3S)', () => {
    it('renders Tier 2 (Notify) by default in violet/accent', () => {
      const result = render(
        <ThemeProvider>
          <StatusBar
            version="0.0.0"
            mode="plan"
            projects={[baseProject]}
            workers={[]}
            sessionId={null}
            autonomyTier={2}
          />
        </ThemeProvider>,
      );
      const frame = result.lastFrame() ?? '';
      // Strip ANSI for content check.
      const plain = frame.replace(
        // eslint-disable-next-line no-control-regex
        /\x1b\[[\d;]*[a-zA-Z]/g,
        '',
      );
      expect(plain).toContain('T2 Notify');
      // theme['accent'] = violet #7C6FEB → 38;2;124;111;235m
      expect(frame).toContain('\x1b[38;2;124;111;235m');
    });

    it('renders Tier 1 (Free) in gold/primary', () => {
      const result = render(
        <ThemeProvider>
          <StatusBar
            version="0.0.0"
            mode="plan"
            projects={[baseProject]}
            workers={[]}
            sessionId={null}
            autonomyTier={1}
          />
        </ThemeProvider>,
      );
      const frame = result.lastFrame() ?? '';
      const plain = frame.replace(
        // eslint-disable-next-line no-control-regex
        /\x1b\[[\d;]*[a-zA-Z]/g,
        '',
      );
      expect(plain).toContain('T1 Free');
      // theme['primary'] = gold #D4A843 → 38;2;212;168;67m
      expect(frame).toContain('\x1b[38;2;212;168;67m');
    });

    it('renders Tier 3 (Confirm) in gold-light/warning', () => {
      const result = render(
        <ThemeProvider>
          <StatusBar
            version="0.0.0"
            mode="plan"
            projects={[baseProject]}
            workers={[]}
            sessionId={null}
            autonomyTier={3}
          />
        </ThemeProvider>,
      );
      const frame = result.lastFrame() ?? '';
      const plain = frame.replace(
        // eslint-disable-next-line no-control-regex
        /\x1b\[[\d;]*[a-zA-Z]/g,
        '',
      );
      expect(plain).toContain('T3 Confirm');
      // theme['warning'] = gold-light #E5C07B → 38;2;229;192;123m
      expect(frame).toContain('\x1b[38;2;229;192;123m');
    });

    it('defaults to Tier 2 when prop omitted', () => {
      const { lastFrame } = renderStatusBar({
        version: '0.0.0',
        mode: 'plan',
        projects: [baseProject],
        workers: [],
        sessionId: null,
      });
      expect(lastFrame()).toContain('T2 Notify');
    });
  });
});
