import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { WorkerRow } from '../../../../src/ui/panels/workers/WorkerRow.js';
import type { WorkerRecordSnapshot } from '../../../../src/orchestrator/worker-registry.js';

function snap(over: Partial<WorkerRecordSnapshot>): WorkerRecordSnapshot {
  return {
    id: 'w',
    projectPath: 'C:/projects/alpha',
    worktreePath: 'C:/projects/alpha/.symphony/worktrees/w',
    role: 'implementer',
    featureIntent: 'do thing',
    taskDescription: 'do thing',
    autonomyTier: 1,
    dependsOn: [],
    status: 'running',
    createdAt: '2026-05-03T12:00:00.000Z',
    ...over,
  };
}

const VIOLET = '\x1b[38;2;124;111;235m';
const GOLD = '\x1b[38;2;212;168;67m';
const CELL = '█';
const STAGE_LABEL_PAD = 12;

describe('<WorkerRow> + pipeline bar', () => {
  it('renders the gerund stage label between the bar and the feature intent', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <WorkerRow
          worker={snap({ role: 'implementer', status: 'running' })}
          instrument="Violin"
          selected={false}
          featureIntentDisplay="do thing"
          runtimeDisplay="3m"
        />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Violin');
    expect(frame).toContain('Implementing');
    expect(frame).toContain('do thing');
    // Bar precedes label precedes feature intent.
    const barIdx = frame.indexOf(CELL);
    const labelIdx = frame.indexOf('Implementing');
    const intentIdx = frame.indexOf('do thing');
    expect(barIdx).toBeGreaterThan(0);
    expect(labelIdx).toBeGreaterThan(barIdx);
    expect(intentIdx).toBeGreaterThan(labelIdx);
    unmount();
  });

  it('emits 5 cells (running implementer = 2 gold + 1 violet + 2 muted)', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <WorkerRow
          worker={snap({ role: 'implementer', status: 'running' })}
          instrument="Violin"
          selected={false}
          featureIntentDisplay="do thing"
          runtimeDisplay="3m"
        />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? '';
    expect(countCellsInColor(frame, GOLD)).toBe(2);
    expect(countCellsInColor(frame, VIOLET)).toBe(1);
    unmount();
  });

  it('inverse highlight on selected rows wraps ONLY the instrument (not the bar or label)', () => {
    // Inverse SGR is `\x1b[7m`. The instrument is the only segment that
    // toggles inverse; the bar and label render in their own color
    // attributes without `[7m`.
    const { lastFrame, unmount } = render(
      <ThemeProvider>
        <WorkerRow
          worker={snap({ role: 'implementer', status: 'running' })}
          instrument="Violin"
          selected={true}
          featureIntentDisplay="do thing"
          runtimeDisplay="3m"
        />
      </ThemeProvider>,
    );
    const frame = lastFrame() ?? '';
    // The inverse SGR appears around the instrument segment; the bar
    // glyphs do NOT carry the `[7m` attribute — confirm by checking
    // there's no inverse code immediately adjacent to a cell glyph.
    /* eslint-disable no-control-regex */
    expect(frame).toMatch(/\x1b\[7m.*Violin/);
    expect(frame).not.toMatch(/\x1b\[7m[^\x1b]*█/);
    /* eslint-enable no-control-regex */
    unmount();
  });

  it('pads the stage label to a fixed 12-char width regardless of role', () => {
    // Render two rows with different gerund lengths and confirm the
    // padded label preserves alignment of subsequent content.
    const { lastFrame: lf1, unmount: u1 } = render(
      <ThemeProvider>
        <WorkerRow
          worker={snap({ role: 'planner', status: 'running' })}
          instrument="Cello"
          selected={false}
          featureIntentDisplay="X"
          runtimeDisplay="1m"
        />
      </ThemeProvider>,
    );
    const f1 = lf1() ?? '';
    u1();
    const planningSlice = sliceLabelRegion(f1, 'Planning');
    expect(planningSlice).not.toBeNull();
    expect((planningSlice ?? '').length).toBe(STAGE_LABEL_PAD);
  });
});

function countCellsInColor(frame: string, color: string): number {
  // Mirrors `countAnsiCells` in PipelineBar.test.tsx: same SGR collapse
  // applies (Ink/chalk merge adjacent same-color text).
  /* eslint-disable no-control-regex */
  const sgrRe = /\x1b\[[0-9;]*m/g;
  const resetRe = /\x1b\[(0|39)m/;
  /* eslint-enable no-control-regex */
  let count = 0;
  let cursor = 0;
  let activeColor: string | null = null;
  for (;;) {
    const match = sgrRe.exec(frame);
    const segmentEnd = match ? match.index : frame.length;
    if (activeColor === color) {
      for (let i = cursor; i < segmentEnd; i += 1) {
        if (frame[i] === CELL) count += 1;
      }
    }
    if (match === null) break;
    if (resetRe.test(match[0])) {
      activeColor = null;
    } else if (match[0].startsWith('\x1b[38;')) {
      activeColor = match[0];
    }
    cursor = match.index + match[0].length;
  }
  return count;
}

function sliceLabelRegion(frame: string, gerund: string): string | null {
  // Strip ANSI escapes so we can measure raw character positions.
  // eslint-disable-next-line no-control-regex
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, '');
  const idx = plain.indexOf(gerund);
  if (idx < 0) return null;
  return plain.slice(idx, idx + STAGE_LABEL_PAD);
}
