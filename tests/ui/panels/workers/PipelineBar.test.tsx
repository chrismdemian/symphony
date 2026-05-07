import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../../src/ui/theme/context.js';
import { PipelineBar } from '../../../../src/ui/panels/workers/PipelineBar.js';
import { WORKER_ROLES, type WorkerRole } from '../../../../src/orchestrator/types.js';
import type { WorkerStatus } from '../../../../src/workers/types.js';

// Truecolor SGR sequences (locked palette; matches src/ui/theme/theme.ts
// + the global TUI Visual Verification rule).
const ANSI = {
  violet: '\x1b[38;2;124;111;235m',
  gold: '\x1b[38;2;212;168;67m',
  red: '\x1b[38;2;224;108;117m',
  muted: '\x1b[38;2;136;136;136m',
} as const;

const CELL = '█';

function frameFor(role: WorkerRole, status: WorkerStatus): string {
  const { lastFrame, unmount } = render(
    <ThemeProvider>
      <PipelineBar role={role} status={status} />
    </ThemeProvider>,
  );
  const out = lastFrame() ?? '';
  unmount();
  return out;
}

function countAnsiCells(frame: string, color: string): number {
  // Ink/chalk collapses adjacent same-color text into one SGR run, so a
  // bar of `█████` all in gold renders as `\x1b[gold]█████\x1b[reset]`,
  // NOT five separate `\x1b[gold]█` segments. Walk the frame, tracking
  // the most recent foreground SGR; count `█` glyphs that fall under
  // the requested color.
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

function stageIndexOf(role: WorkerRole): number {
  switch (role) {
    case 'researcher':
      return 0;
    case 'planner':
      return 1;
    case 'implementer':
      return 2;
    case 'debugger':
      return 3;
    case 'reviewer':
      return 4;
  }
}

describe('<PipelineBar>', () => {
  // Cell-count is verified implicitly by every per-status describe
  // block below (the per-color counts must sum to 5). A standalone
  // matrix sanity test (5 × 7 = 35 renders ≈ 10s) was removed because
  // it competed for CPU with other parallel-test-suite cases and
  // tipped marginal timing-sensitive tests past their timeouts.
  describe('cell coloring — active worker (running/spawning)', () => {
    for (const status of ['spawning', 'running'] as const) {
      for (const role of WORKER_ROLES) {
        it(`${role} ${status}: cells before stage gold, current violet, after dim`, () => {
          const frame = frameFor(role, status);
          const idx = stageIndexOf(role);
          expect(countAnsiCells(frame, ANSI.gold)).toBe(idx);
          expect(countAnsiCells(frame, ANSI.violet)).toBe(1);
          expect(countAnsiCells(frame, ANSI.muted)).toBe(4 - idx);
          expect(countAnsiCells(frame, ANSI.red)).toBe(0);
        });
      }
    }
  });

  describe('cell coloring — completed worker', () => {
    for (const role of WORKER_ROLES) {
      it(`${role} completed: bar fully gold (current cell collapses to gold)`, () => {
        const frame = frameFor(role, 'completed');
        const idx = stageIndexOf(role);
        // Prior + current = idx + 1 gold cells; remaining are dim.
        expect(countAnsiCells(frame, ANSI.gold)).toBe(idx + 1);
        expect(countAnsiCells(frame, ANSI.muted)).toBe(4 - idx);
        expect(countAnsiCells(frame, ANSI.violet)).toBe(0);
        expect(countAnsiCells(frame, ANSI.red)).toBe(0);
      });
    }

    it('reviewer completed → all 5 cells gold', () => {
      const frame = frameFor('reviewer', 'completed');
      expect(countAnsiCells(frame, ANSI.gold)).toBe(5);
      expect(countAnsiCells(frame, ANSI.muted)).toBe(0);
    });
  });

  describe('cell coloring — failed/crashed/timeout', () => {
    for (const status of ['failed', 'crashed', 'timeout'] as const) {
      for (const role of WORKER_ROLES) {
        it(`${role} ${status}: prior gold + current red + after dim`, () => {
          const frame = frameFor(role, status);
          const idx = stageIndexOf(role);
          expect(countAnsiCells(frame, ANSI.gold)).toBe(idx);
          expect(countAnsiCells(frame, ANSI.red)).toBe(1);
          expect(countAnsiCells(frame, ANSI.muted)).toBe(4 - idx);
          expect(countAnsiCells(frame, ANSI.violet)).toBe(0);
        });
      }
    }
  });

  describe('cell coloring — killed', () => {
    for (const role of WORKER_ROLES) {
      it(`${role} killed: prior gold + current dim (paused) + after dim`, () => {
        const frame = frameFor(role, 'killed');
        const idx = stageIndexOf(role);
        // workerPaused resolves to grayMuted (#888888) — same SGR as
        // textMuted. Current + after collapse to a single muted run.
        expect(countAnsiCells(frame, ANSI.gold)).toBe(idx);
        expect(countAnsiCells(frame, ANSI.muted)).toBe(5 - idx);
        expect(countAnsiCells(frame, ANSI.violet)).toBe(0);
        expect(countAnsiCells(frame, ANSI.red)).toBe(0);
      });
    }
  });
});
