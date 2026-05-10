/**
 * Phase 3L — visual frame harness for the task queue panel.
 *
 * Captures the WorkerPanel under canonical queue-rendering states for
 * a SEPARATE skeptical-subagent review. Mirrors the 3I/3K harness
 * shape.
 *
 * Output: `.visual-frames/3l-<state>.{ansi,plain}.txt` + `INDEX-3l.md`.
 *
 * Locked palette under review (CLAUDE.md):
 *   - violet `#7C6FEB`  → `\x1b[38;2;124;111;235m` (Queue header label, accent gutter)
 *   - text  `#E0E0E0`   → `\x1b[38;2;224;224;224m` (feature intent body)
 *   - muted `#888888`   → `\x1b[38;2;136;136;136m` (Next →, ordinal prefix, project parens)
 *   - inverse           → `\x1b[7m` (selected queue row's feature intent)
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider, useFocus } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { buildGlobalCommands } from '../../src/ui/keybinds/global.js';
import {
  WorkerSelectionProvider,
  useWorkerSelection,
} from '../../src/ui/data/WorkerSelection.js';
import { ToastProvider } from '../../src/ui/feedback/ToastProvider.js';
import { WorkerPanel } from '../../src/ui/panels/workers/WorkerPanel.js';
import type { WorkerRecordSnapshot } from '../../src/orchestrator/worker-registry.js';
import type { PendingSpawnSnapshot } from '../../src/rpc/router-impl.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';
import type { UseWorkersResult } from '../../src/ui/data/useWorkers.js';
import type { UseQueueResult } from '../../src/ui/data/useQueue.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

function snap(over: Partial<WorkerRecordSnapshot>): WorkerRecordSnapshot {
  return {
    id: 'w',
    projectPath: '/repos/MathScrabble',
    worktreePath: '/repos/MathScrabble/.symphony/worktrees/w',
    role: 'implementer',
    featureIntent: 'do thing',
    taskDescription: 'do thing',
    autonomyTier: 1,
    dependsOn: [],
    status: 'running',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

function pending(over: Partial<PendingSpawnSnapshot>): PendingSpawnSnapshot {
  return {
    recordId: over.recordId ?? 'rec-1',
    projectPath: over.projectPath ?? '/repos/MathScrabble',
    featureIntent: over.featureIntent ?? 'add filters',
    taskDescription: over.taskDescription ?? 'add filters',
    enqueuedAt: over.enqueuedAt ?? 1000,
  };
}

function makeFakeRpc(): TuiRpc {
  return {
    call: {
      projects: {
        list: async () => [],
        get: async () => null,
        register: async () => {
          throw new Error('unused');
        },
      },
      tasks: {
        list: async () => [],
        get: async () => null,
        create: async () => {
          throw new Error('unused');
        },
        update: async () => {
          throw new Error('unused');
        },
      },
      workers: {
        list: async () => [],
        get: async () => null,
        kill: async () => ({ killed: false }),
      },
      questions: {
        list: async () => [],
        get: async () => null,
        answer: async () => {
          throw new Error('unused');
        },
      },
      waves: {
        list: async () => [],
        get: async () => null,
      },
      mode: {
        get: async () => ({ mode: 'plan' as const }),
      },
      queue: {
        list: async () => [],
        cancel: async () => ({ cancelled: false, reason: 'not in queue' }),
        reorder: async () => ({ moved: false, reason: 'not in queue' }),
      },
      notifications: {
        flushAwayDigest: async () => undefined,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    subscribe: async () => ({ topic: 'noop', unsubscribe: async () => {} }),
    close: async () => {},
  };
}

function makeWorkersResult(workers: readonly WorkerRecordSnapshot[]): UseWorkersResult {
  return {
    workers,
    loading: false,
    error: null,
    refresh: () => {},
  };
}

function makeQueueResult(items: readonly PendingSpawnSnapshot[]): UseQueueResult {
  return {
    pending: items,
    loading: false,
    error: null,
    refresh: () => {},
  };
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

interface ScenarioContext {
  selectId: (id: string | null) => void;
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly workers: readonly WorkerRecordSnapshot[];
  readonly pending: readonly PendingSpawnSnapshot[];
  readonly build?: (ctx: ScenarioContext) => Promise<void>;
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-empty-queue',
    description:
      'No pending entries. The queue header MUST NOT render — only the project group + worker rows.',
    workers: [snap({ id: 'wk-1', featureIntent: 'wire friend system' })],
    pending: [],
  },
  {
    name: '02-single-pending',
    description:
      'One queued entry. Header reads "Queue  (1 pending)" in violet; head row uses "Next →" prefix. No "2." rows.',
    workers: [snap({ id: 'wk-1', featureIntent: 'wire friend system' })],
    pending: [pending({ recordId: 'r1', featureIntent: 'add search filters' })],
  },
  {
    name: '03-multi-project-pending',
    description:
      'Four queued entries across three projects (matches PLAN.md sample). Verify ordinal alignment (" 2." " 3." " 4."), violet header, muted project parens, text-light feature intents.',
    workers: [snap({ id: 'wk-1', featureIntent: 'work in progress' })],
    pending: [
      pending({
        recordId: 'r1',
        projectPath: '/repos/MathScrabble',
        featureIntent: 'Add search filters',
        enqueuedAt: 1000,
      }),
      pending({
        recordId: 'r2',
        projectPath: '/repos/CRE Pipeline',
        featureIntent: 'Fix scraper timeout',
        enqueuedAt: 1100,
      }),
      pending({
        recordId: 'r3',
        projectPath: '/repos/Pulse Intel',
        featureIntent: 'Update auth middleware',
        enqueuedAt: 1200,
      }),
      pending({
        recordId: 'r4',
        projectPath: '/repos/Pulse Intel',
        featureIntent: 'Write API tests',
        enqueuedAt: 1300,
      }),
    ],
  },
  {
    name: '04-mixed-active-and-queued',
    description:
      'Three running workers in two projects PLUS three queued tasks. Verifies the worker rows render first, then the queue section (separator + violet header + numbered rows).',
    workers: [
      snap({
        id: 'wk-1',
        projectPath: '/repos/MathScrabble',
        featureIntent: 'wire friend system',
        role: 'implementer',
      }),
      snap({
        id: 'wk-2',
        projectPath: '/repos/MathScrabble',
        featureIntent: 'fix lint warnings',
        role: 'reviewer',
        status: 'completed',
      }),
      snap({
        id: 'wk-3',
        projectPath: '/repos/CRE Pipeline',
        featureIntent: 'survey scraper libs',
        role: 'researcher',
      }),
    ],
    pending: [
      pending({
        recordId: 'r1',
        projectPath: '/repos/MathScrabble',
        featureIntent: 'add search filters',
        enqueuedAt: 1000,
      }),
      pending({
        recordId: 'r2',
        projectPath: '/repos/CRE Pipeline',
        featureIntent: 'fix scraper timeout',
        enqueuedAt: 1100,
      }),
      pending({
        recordId: 'r3',
        projectPath: '/repos/Pulse Intel',
        featureIntent: 'update auth',
        enqueuedAt: 1200,
      }),
    ],
  },
  {
    name: '05-narrow-truncation',
    description:
      'Long feature intents at a narrow column width — they should fit within the 30-char budget with ellipsis suffix.',
    workers: [],
    pending: [
      pending({
        recordId: 'r1',
        featureIntent:
          'Wire up the entire friend system across four API routes and three migrations',
      }),
      pending({
        recordId: 'r2',
        projectPath: '/repos/CRE Pipeline',
        featureIntent:
          'Refactor the database schema to support multiple tenants with row-level security',
        enqueuedAt: 2000,
      }),
    ],
  },
];

function FocusForcer({ to }: { readonly to: 'workers' }): React.JSX.Element {
  const focus = useFocus();
  React.useEffect(() => {
    focus.setMain(to);
  }, [focus, to]);
  return <></>;
}

function SelectionExposer({
  onReady,
}: {
  readonly onReady: (selectId: (id: string | null) => void) => void;
}): React.JSX.Element {
  const sel = useWorkerSelection();
  React.useEffect(() => {
    onReady((id) => sel.setSelectedId(id));
  }, [sel, onReady]);
  return <></>;
}

async function captureScenario(scenario: Scenario): Promise<{ ansi: string; plain: string }> {
  let selectIdFn: ((id: string | null) => void) | null = null;
  const onSelectionReady = (fn: (id: string | null) => void): void => {
    selectIdFn = fn;
  };

  const commands = buildGlobalCommands({
    cycleFocus: () => {},
    cycleFocusReverse: () => {},
    requestExit: () => {},
    showHelp: () => {},
  });

  const tree = (
    <ThemeProvider>
      <ToastProvider>
        <FocusProvider>
          <FocusForcer to="workers" />
          <WorkerSelectionProvider>
            <SelectionExposer onReady={onSelectionReady} />
            <KeybindProvider initialCommands={commands}>
              <WorkerPanel
                rpc={makeFakeRpc()}
                workersResult={makeWorkersResult(scenario.workers)}
                queueResult={makeQueueResult(scenario.pending)}
              />
            </KeybindProvider>
          </WorkerSelectionProvider>
        </FocusProvider>
      </ToastProvider>
    </ThemeProvider>
  );

  const result = render(tree);
  await flush();
  await flush();

  const ctx: ScenarioContext = {
    selectId: (id) => {
      if (selectIdFn !== null) selectIdFn(id);
    },
  };
  if (scenario.build !== undefined) {
    await scenario.build(ctx);
  }
  await flush();
  await flush();

  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const summary: string[] = [
    '# Phase 3L visual frames — Task Queue Panel',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the WorkerPanel with a static `queueResult` fixture.',
    'Inspect `.plain.txt` for human review; `.ansi.txt` keeps the color escapes.',
    '',
    'Locked palette under review (CLAUDE.md §Symphony palette):',
    '- violet `#7C6FEB` (`Queue` header + accent gutter) → `\\x1b[38;2;124;111;235m`',
    '- text light gray `#E0E0E0` (feature intent body) → `\\x1b[38;2;224;224;224m`',
    '- muted gray `#888888` (`Next →`, ordinal prefix, `(project)` parens) → `\\x1b[38;2;136;136;136m`',
    '- inverse → `\\x1b[7m` (wraps selected queue row\'s feature intent text only)',
    '',
    'Layout invariants to verify:',
    '- queue header rows render ONLY when pending.length > 0 (scenario 01: header absent)',
    '- "Next →" is the head row\'s prefix (ordinal 1); subsequent rows use right-aligned " 2." " 3." " 4."',
    '- feature intent text in text-light color, project parens in muted-gray',
    '- selected row inverse wraps the intent text only — not the gutter, prefix, or project parens',
    '- queue section sits BELOW worker rows; not above',
    '- long intents truncate at ~30 chars with `…` suffix; the project parens always render',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3l-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3l-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3l.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
