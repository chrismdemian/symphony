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
});
