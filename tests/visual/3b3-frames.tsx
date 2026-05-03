/**
 * Phase 3B.3 — visual frame harness.
 *
 * Adds 3B.3-specific scenarios on top of 3B.2 baseline:
 *   - Equalizer + ShimmerText status line under various verb dispatches
 *   - Animation progress captured at multiple frame indices
 *   - Idle state has no status glyphs / verbs visible
 *
 * Animation timing: this harness uses real timers + `setTimeout` await
 * loops to capture frames at known wall-clock offsets. ink-testing-library
 * doesn't expose a way to drive the Ink AnimationContext from outside
 * the React tree; the alternative would be to fork the harness onto
 * `vi.useFakeTimers`, but that conflicts with `setImmediate` flush
 * patterns the rest of the harness relies on. Real timers + small
 * 200 ms waits is good enough for static dumps.
 *
 * Output: `.visual-frames/3b3-<state>.{ansi,plain}.txt`.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider } from '../../src/ui/focus/focus.js';
import { AppActionsProvider } from '../../src/ui/runtime/AppActions.js';
import { ChatPanel } from '../../src/ui/panels/chat/ChatPanel.js';
import {
  MaestroEventsProvider,
  useMaestroData,
  type MaestroController,
} from '../../src/ui/data/MaestroEventsProvider.js';
import {
  MaestroTurnInFlightError,
  type MaestroEvent,
} from '../../src/orchestrator/maestro/process.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

class FakeMaestro implements MaestroController {
  readonly emitter = new EventEmitter();
  throwOnSend: 'none' | 'in-flight' | 'epipe' = 'none';

  sendUserMessage(_text: string): void {
    if (this.throwOnSend === 'in-flight') throw new MaestroTurnInFlightError();
    if (this.throwOnSend === 'epipe') throw new Error('write EPIPE');
  }

  events(): AsyncIterable<MaestroEvent> {
    const queue: MaestroEvent[] = [];
    const waiters: Array<(e: MaestroEvent | undefined) => void> = [];
    let stopped = false;
    const onEvent = (e: MaestroEvent): void => {
      const w = waiters.shift();
      if (w !== undefined) w(e);
      else queue.push(e);
    };
    const onStop = (): void => {
      stopped = true;
      while (waiters.length > 0) waiters.shift()!(undefined);
    };
    this.emitter.on('event', onEvent);
    this.emitter.once('stopped', onStop);
    const emitter = this.emitter;

    const iter: AsyncIterableIterator<MaestroEvent> = {
      [Symbol.asyncIterator]() {
        return iter;
      },
      async next(): Promise<IteratorResult<MaestroEvent>> {
        if (queue.length > 0) return { value: queue.shift()!, done: false };
        if (stopped) return { value: undefined as never, done: true };
        const next = await new Promise<MaestroEvent | undefined>((r) => waiters.push(r));
        if (next === undefined) return { value: undefined as never, done: true };
        return { value: next, done: false };
      },
      async return(): Promise<IteratorResult<MaestroEvent>> {
        emitter.off('event', onEvent);
        emitter.off('stopped', onStop);
        return { value: undefined as never, done: true };
      },
    };
    return iter;
  }

  emit(event: MaestroEvent): void {
    this.emitter.emit('event', event);
  }
}

interface PartialScenarioContext {
  push: (text: string) => void;
}

interface ScenarioContext extends PartialScenarioContext {
  type: (bytes: string) => void;
}

function HarnessHooks(props: {
  onReady: (ctx: PartialScenarioContext) => void;
}): React.JSX.Element {
  const data = useMaestroData();
  React.useEffect(() => {
    props.onReady({ push: data.pushUserMessage });
  }, [data, props]);
  return React.createElement(React.Fragment, null);
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Scenario {
  name: string;
  description: string;
  /** Optional override of post-build pause to settle animation tick. */
  settleMs?: number;
  build: (ctx: { maestro: FakeMaestro; harness: ScenarioContext }) => Promise<void>;
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-status-line-conducting',
    description: 'Mid-turn, spawn_worker tool — Equalizer + Conducting verb.',
    build: async ({ harness, maestro }) => {
      harness.push('spawn a researcher');
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'spawn_worker',
        input: { role: 'researcher', task: 'investigate options' },
      });
      await flush();
      await wait(200);
    },
  },
  {
    name: '02-status-line-listening',
    description: 'Mid-turn, list_workers tool — Equalizer + Listening verb.',
    build: async ({ harness, maestro }) => {
      harness.push('what is running?');
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'list_workers',
        input: {},
      });
      await flush();
      await wait(200);
    },
  },
  {
    name: '03-status-line-phrasing',
    description: 'Mid-turn, open text block, no current tool — Phrasing verb.',
    build: async ({ harness, maestro }) => {
      harness.push('explain your plan');
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({ type: 'assistant_text', text: 'Here is what I want to do…' });
      await flush();
      await wait(200);
    },
  },
  {
    name: '04-status-line-composing',
    description: 'Mid-turn, no text yet, no tool — default Composing verb.',
    build: async ({ maestro }) => {
      maestro.emit({ type: 'turn_started' });
      await flush();
      await wait(200);
    },
  },
  {
    name: '05-status-line-resolving',
    description: 'Mid-turn, finalize tool — Equalizer + Resolving verb.',
    build: async ({ harness, maestro }) => {
      harness.push('ship it');
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'finalize',
        input: { branch: 'feat/3b3' },
      });
      await flush();
      await wait(200);
    },
  },
  {
    name: '06-no-status-when-idle',
    description: 'No turn active — status line area is empty (no glyphs, no verb).',
    build: async () => {
      await flush();
      await wait(50);
    },
  },
  {
    name: '07-status-clears-on-completion',
    description: 'Full turn lifecycle: started → tool → result → completed; final frame has no status.',
    build: async ({ harness, maestro }) => {
      harness.push('quick check');
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'list_projects',
        input: {},
      });
      await flush();
      maestro.emit({
        type: 'tool_result',
        callId: 'c1',
        content: 'symphony',
        isError: false,
      });
      await flush();
      maestro.emit({
        type: 'assistant_text',
        text: 'One project: symphony.',
      });
      await flush();
      maestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
      await flush();
      await wait(50);
    },
  },
  {
    name: '08-equalizer-progress-frame-a',
    description: 'EQ animation captured at t≈100ms (one tick in) — frame A of pair.',
    settleMs: 100,
    build: async ({ harness, maestro }) => {
      harness.push('hold');
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'audit_changes',
        input: { workerId: 'w-1' },
      });
      await flush();
    },
  },
  {
    name: '08-equalizer-progress-frame-b',
    description: 'EQ animation captured at t≈700ms (multiple ticks in) — frame B differs from A.',
    settleMs: 700,
    build: async ({ harness, maestro }) => {
      harness.push('hold');
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'audit_changes',
        input: { workerId: 'w-1' },
      });
      await flush();
    },
  },
  {
    name: '09-shimmer-spectrum',
    description: 'EQ + Auditioning verb captured ~600ms in; shimmer phase across the verb is the focus here, not parity with frames 08-a/b (different verb).',
    settleMs: 600,
    build: async ({ harness, maestro }) => {
      harness.push('thinking out loud');
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'research_wave',
        input: { n: 3, intent: 'survey approaches' },
      });
      await flush();
    },
  },
  {
    name: '10-multiline-input-renders',
    description: 'Multi-line input buffer (Ctrl+J newlines) — InputBar draft and status line both visible.',
    build: async ({ harness, maestro }) => {
      // Type a real multi-line draft into the InputBar via Ctrl+J newlines
      // (the universal newline fallback). `harness.type` writes raw bytes
      // through the ink-testing-library stdin so the InputBar's `useInput`
      // handler actually receives keystrokes — `harness.push` would only
      // append to history (audit follow-up: 3B.3 visual review).
      harness.type('first line');
      await flush();
      harness.type('\x0a'); // Ctrl+J
      harness.type('second line');
      await flush();
      harness.type('\x0a');
      harness.type('third line ends here');
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'create_task',
        input: { description: 'three-line task' },
      });
      await flush();
      await wait(200);
    },
  },
];

async function captureScenario(scenario: Scenario): Promise<{
  ansi: string;
  plain: string;
}> {
  const maestro = new FakeMaestro();
  let harnessCtx: PartialScenarioContext | undefined;
  const tree = React.createElement(
    ThemeProvider,
    null,
    React.createElement(
      FocusProvider,
      null,
      React.createElement(AppActionsProvider, {
        value: { onRequestExit: () => undefined },
        children: React.createElement(MaestroEventsProvider, {
          source: maestro,
          now: () => 0,
          children: [
            React.createElement(HarnessHooks, {
              key: 'harness',
              onReady: (ctx) => {
                harnessCtx = ctx;
              },
            }),
            React.createElement(ChatPanel, { key: 'chat' }),
          ],
        }),
      }),
    ),
  );
  const result = render(tree);
  await flush();
  await flush();
  if (harnessCtx === undefined) {
    throw new Error(`scenario ${scenario.name}: harness never resolved`);
  }
  const stdin = (result as unknown as { stdin: { write: (s: string) => void } }).stdin;
  const harness: ScenarioContext = {
    ...harnessCtx,
    type: (bytes: string) => stdin.write(bytes),
  };
  await scenario.build({ maestro, harness });
  if (scenario.settleMs !== undefined) {
    await wait(scenario.settleMs);
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
    '# Phase 3B.3 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the ChatPanel under a 3B.3 canonical state.',
    'Inspect `.plain.txt` for human-readable review;',
    '`.ansi.txt` keeps the color escapes (grep `\\x1b[38;2;…m` for hex codes).',
    '',
    'Palette under review:',
    '- violet `#7C6FEB` → `\\x1b[38;2;124;111;235m`',
    '- gold `#D4A843` → `\\x1b[38;2;212;168;67m`',
    '- red `#E06C75` → `\\x1b[38;2;224;108;117m`',
    '- text light gray `#E0E0E0` → `\\x1b[38;2;224;224;224m`',
    '- muted gray `#888888` → `\\x1b[38;2;136;136;136m`',
    '- cursor inverse → `\\x1b[7m`',
    '',
    'Verbs to verify:',
    '- spawn_worker → Conducting',
    '- list_workers → Listening',
    '- finalize → Resolving',
    '- audit_changes → Cadencing',
    '- research_wave → Auditioning',
    '- create_task → Scoring',
    '- (no tool, open text) → Phrasing',
    '- (no tool, no text) → Composing',
    '',
    'Equalizer glyphs `▁▂▃▄▅▆▇█` should appear in 4-column groups where status is visible.',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3b3-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3b3-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(
    path.join(OUT_DIR, 'INDEX-3b3.md'),
    summary.join('\n') + '\n',
    'utf8',
  );
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
