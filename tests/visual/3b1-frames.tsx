/**
 * Phase 3B.1 — visual frame harness.
 *
 * Renders the chat panel in canonical states and writes each frame to
 * `.visual-frames/3b1-<state>.{ansi,plain}.txt`:
 *  - `.ansi.txt` keeps the raw ANSI escape sequences (what a real
 *    terminal sees) — useful for diff regression and re-rendering
 *  - `.plain.txt` strips ANSI to readable text — a skeptical
 *    subagent reads this for visual review
 *
 * Run via `pnpm visual:3b1`. Output is gitignored. The launcher at
 * `tests/visual/run.mjs` sets `FORCE_COLOR=3` BEFORE this process
 * starts so chalk's level is resolved to truecolor at import time.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider } from '../../src/ui/focus/focus.js';
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
  send: (text: string) => void;
}

interface ScenarioContext extends PartialScenarioContext {
  /** Write raw bytes to the harness stdin (drives InputBar's useInput). */
  type: (bytes: string) => void;
}

function HarnessHooks(props: {
  onReady: (ctx: PartialScenarioContext) => void;
}): React.JSX.Element {
  const data = useMaestroData();
  React.useEffect(() => {
    props.onReady({
      push: data.pushUserMessage,
      send: (text: string) => {
        data.sendUserMessage(text);
      },
    });
  }, [data, props]);
  return React.createElement(React.Fragment, null);
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

interface Scenario {
  name: string;
  description: string;
  build: (ctx: { maestro: FakeMaestro; harness: ScenarioContext }) => Promise<void>;
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-empty',
    description: 'Empty chat panel — placeholder state on first launch.',
    build: async () => {
      // No-op — render the empty state.
    },
  },
  {
    name: '02-single-user-message',
    description: 'A single user message rendered with the violet chevron.',
    build: async ({ harness }) => {
      harness.push('Can you list my projects?');
      await flush();
      await flush();
    },
  },
  {
    name: '03-streaming-reply',
    description: 'User message + streamed assistant reply (chunks coalesce into one bubble).',
    build: async ({ harness, maestro }) => {
      harness.push('Hello, Maestro.');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({ type: 'assistant_text', text: 'Hi! ' });
      await flush();
      maestro.emit({ type: 'assistant_text', text: 'How can I ' });
      await flush();
      maestro.emit({ type: 'assistant_text', text: 'help today?' });
      await flush();
      maestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
      await flush();
      await flush();
    },
  },
  {
    name: '04-tool-call-in-flight',
    description: 'Tool call mid-flight (✗ pending marker, … status pip).',
    build: async ({ harness, maestro }) => {
      harness.push('Show me the active workers.');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({ type: 'assistant_text', text: 'Looking up workers.' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'list_workers',
        input: {},
      });
      await flush();
      await flush();
    },
  },
  {
    name: '05-tool-call-success',
    description: 'Tool call resolved successfully (gold ✓ pip) + follow-up text.',
    build: async ({ harness, maestro }) => {
      harness.push('list workers');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({ type: 'assistant_text', text: 'Checking workers now.' });
      await flush();
      maestro.emit({ type: 'tool_use', callId: 'c1', name: 'list_workers', input: {} });
      await flush();
      maestro.emit({
        type: 'tool_result',
        callId: 'c1',
        content: 'No workers active.',
        isError: false,
      });
      await flush();
      maestro.emit({
        type: 'assistant_text',
        text: 'No workers are currently running. Want me to spawn one?',
      });
      await flush();
      maestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
      await flush();
      await flush();
    },
  },
  {
    name: '06-tool-call-error',
    description: 'Tool call failed (red ✗ pip).',
    build: async ({ harness, maestro }) => {
      harness.push('audit my changes');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({ type: 'tool_use', callId: 'c1', name: 'audit_changes', input: {} });
      await flush();
      maestro.emit({
        type: 'tool_result',
        callId: 'c1',
        content: 'Detached HEAD',
        isError: true,
      });
      await flush();
      maestro.emit({
        type: 'assistant_text',
        text: 'Audit failed — your worktree is in a detached HEAD state.',
      });
      await flush();
      maestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
      await flush();
      await flush();
    },
  },
  {
    name: '07-thinking-block',
    description: 'Thinking block rendered with ⚡ Thinking: prefix.',
    build: async ({ harness, maestro }) => {
      harness.push('What should I focus on?');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'assistant_thinking',
        text: 'Considering the project context and recent changes.',
      });
      await flush();
      maestro.emit({
        type: 'assistant_text',
        text: 'I think you should ship Phase 3B.2 next.',
      });
      await flush();
      maestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
      await flush();
      await flush();
    },
  },
  {
    name: '08-multi-turn-conversation',
    description: 'Multiple turns — user, assistant, user, assistant — exercising scroll position.',
    build: async ({ harness, maestro }) => {
      harness.push('hi');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({ type: 'assistant_text', text: 'Hello! What would you like to do?' });
      await flush();
      maestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
      await flush();
      harness.push('list my projects');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({ type: 'assistant_text', text: 'Here you go:' });
      await flush();
      maestro.emit({ type: 'tool_use', callId: 'c1', name: 'list_projects', input: {} });
      await flush();
      maestro.emit({
        type: 'tool_result',
        callId: 'c1',
        content: 'symphony, mathscrabble',
        isError: false,
      });
      await flush();
      maestro.emit({
        type: 'assistant_text',
        text: 'You have 2 projects: symphony and mathscrabble.',
      });
      await flush();
      maestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
      await flush();
      await flush();
    },
  },
  {
    name: '09-error-event',
    description: 'Error event — assistant turn closed with red error block.',
    build: async ({ harness, maestro }) => {
      harness.push('do something');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({ type: 'assistant_text', text: 'Working on it...' });
      await flush();
      maestro.emit({ type: 'error', reason: 'rate limit exceeded — retry in 30s' });
      await flush();
      await flush();
    },
  },
  {
    name: '10-turn-in-flight-error',
    description: 'User types Enter while a turn streams — inline error in input bar.',
    build: async ({ maestro, harness }) => {
      // First turn streams.
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({ type: 'assistant_text', text: 'Streaming reply…' });
      await flush();
      // User types into the input AND hits Enter — sendUserMessage
      // throws MaestroTurnInFlightError, ChatPanel sets the error
      // message which renders below the input.
      maestro.throwOnSend = 'in-flight';
      harness.type('hurry up');
      await flush();
      harness.type('\r');
      await flush();
      await flush();
    },
  },
  {
    name: '11-typed-input-with-cursor',
    description: 'User has typed partial input — cursor highlight visible at end of buffer.',
    build: async ({ harness }) => {
      harness.type('Spawn a worker');
      await flush();
      await flush();
    },
  },
  {
    name: '12-multiline-input-via-ctrl-j',
    description: 'Multi-line input buffer (Ctrl+J newline universal fallback).',
    build: async ({ harness }) => {
      harness.type('first line');
      await flush();
      harness.type('\x0a'); // Ctrl+J = LF
      harness.type('second line');
      await flush();
      harness.type('\x0a');
      harness.type('third line');
      await flush();
      await flush();
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
      React.createElement(
        MaestroEventsProvider,
        {
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
        },
      ),
    ),
  );
  const result = render(tree);
  await flush();
  await flush();
  if (harnessCtx === undefined) {
    throw new Error(`scenario ${scenario.name}: harness never resolved`);
  }
  // ink-testing-library's `result.stdin.write(bytes)` fires Ink's
  // input parser exactly like a real keystroke would.
  const stdin = (result as unknown as { stdin: { write: (s: string) => void } }).stdin;
  const harness: ScenarioContext = {
    ...harnessCtx,
    type: (bytes: string) => stdin.write(bytes),
  };
  await scenario.build({ maestro, harness });
  await flush();
  await flush();

  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

function stripAnsi(input: string): string {
  // Strip the ANSI control sequences ink emits for color, cursor moves,
  // alt-screen toggles, etc. Same regex shape `strip-ansi` uses.
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const summary: string[] = [
    '# Phase 3B.1 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the ChatPanel under canonical states.',
    'Inspect the `.plain.txt` files for human-readable visual review;',
    '`.ansi.txt` files preserve color/style escapes for terminal replay.',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3b1-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3b1-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
