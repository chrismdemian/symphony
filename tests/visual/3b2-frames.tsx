/**
 * Phase 3B.2 — visual frame harness.
 *
 * Adds 3B.2-specific scenarios on top of 3B.1 baseline:
 *   - extracted tool summaries (file_path, command, query)
 *   - ANSI-stripped tool result bodies (multi-line, truncation hint)
 *   - thinking block as bare `thinking` italic prose (no glyph)
 *   - unknown slash command inline error
 *   - paste preview rendering a multi-line buffer
 *
 * Reuses the FakeMaestro + ChatPanel + AppActionsProvider stack. Output:
 * `.visual-frames/3b2-<state>.{ansi,plain}.txt`.
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
  send: (text: string) => void;
}

interface ScenarioContext extends PartialScenarioContext {
  type: (bytes: string) => void;
}

function HarnessHooks(props: {
  onReady: (ctx: PartialScenarioContext) => void;
}): React.JSX.Element {
  const data = useMaestroData();
  React.useEffect(() => {
    props.onReady({
      push: data.pushUserMessage,
      send: (text: string) => data.sendUserMessage(text),
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
    name: '01-tool-pending-with-summary',
    description: 'Tool call mid-flight with a Read file_path summary inline.',
    build: async ({ harness, maestro }) => {
      harness.push('Read /etc/hosts');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({ type: 'assistant_text', text: 'Reading the file now.' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'Read',
        input: { file_path: '/etc/hosts' },
      });
      await flush();
      await flush();
    },
  },
  {
    name: '02-tool-success-with-multiline-result',
    description: 'Successful Bash command with a multi-line, ANSI-coded result body.',
    build: async ({ harness, maestro }) => {
      harness.push('check git status');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'Bash',
        input: { command: 'git status --short' },
      });
      await flush();
      maestro.emit({
        type: 'tool_result',
        callId: 'c1',
        // ANSI-coded git output — formatToolResult should strip everything.
        content:
          '\x1b[32m M\x1b[m src/ui/panels/chat/MessageList.tsx\n\x1b[31m??\x1b[m tests/scenarios/3b2.md',
        isError: false,
      });
      await flush();
      maestro.emit({
        type: 'assistant_text',
        text: 'You have one modified file and one untracked.',
      });
      await flush();
      maestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
      await flush();
      await flush();
    },
  },
  {
    name: '03-tool-error',
    description: 'Tool call failure — red ✗ pip with the failure body.',
    build: async ({ harness, maestro }) => {
      harness.push('finalize');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'finalize',
        input: { branch: 'feat/3b2' },
      });
      await flush();
      maestro.emit({
        type: 'tool_result',
        callId: 'c1',
        content: 'merge conflict on src/ui/panels/chat/MessageList.tsx',
        isError: true,
      });
      await flush();
      maestro.emit({ type: 'turn_completed', isError: true, resultText: '' });
      await flush();
      await flush();
    },
  },
  {
    name: '04-thinking-block-prose',
    description: 'Thinking block — bare `thinking` italic prefix, no glyph, multi-line body.',
    build: async ({ harness, maestro }) => {
      harness.push('what should I focus on?');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'assistant_thinking',
        text: 'The plan calls for shipping 3B.2 next.\nKey gaps: tool summaries, paste, scroll, /quit.\nI will recommend that order.',
      });
      await flush();
      maestro.emit({
        type: 'assistant_text',
        text: 'Ship 3B.2 now — it unlocks tool readability.',
      });
      await flush();
      maestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
      await flush();
      await flush();
    },
  },
  {
    name: '05-unknown-slash-command',
    description: 'User typed /foo — InputBar inline error surfaces, message NOT sent.',
    build: async ({ harness }) => {
      harness.type('/foo');
      await flush();
      harness.type('\r');
      await flush();
      await flush();
    },
  },
  {
    name: '06-multiline-paste-preview',
    description: 'Pasted three-line buffer rendered with cursor at the end (Ctrl+J fallback).',
    build: async ({ harness }) => {
      harness.type('first line');
      await flush();
      harness.type('\x0a');
      harness.type('second line');
      await flush();
      harness.type('\x0a');
      harness.type('third line ends here');
      await flush();
      await flush();
    },
  },
  {
    name: '07-tool-with-grep-pattern-summary',
    description: 'Grep pattern summary inline (no path — pattern alone wins the priority); result lists matches.',
    build: async ({ harness, maestro }) => {
      harness.push('grep for TODOs');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'Grep',
        // SUMMARY_KEYS priority is `file_path > path > command > pattern
        // > query > prompt`. Omit `path` so `pattern` wins — this
        // scenario's purpose is to demonstrate pattern extraction, not
        // priority ordering (covered in unit tests).
        input: { pattern: 'TODO\\b' },
      });
      await flush();
      maestro.emit({
        type: 'tool_result',
        callId: 'c1',
        content:
          'src/ui/panels/chat/MessageList.tsx:35: // TODO: per-line viewport\nsrc/orchestrator/safety.ts:12: // TODO: budget integration',
        isError: false,
      });
      await flush();
      maestro.emit({ type: 'assistant_text', text: 'Two TODOs in src/.' });
      await flush();
      maestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
      await flush();
      await flush();
    },
  },
  {
    name: '08-tool-without-canonical-summary',
    description: 'Tool with no canonical input field — header is just the name + status.',
    build: async ({ harness, maestro }) => {
      harness.push('list projects');
      await flush();
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
        content: 'symphony, mathscrabble',
        isError: false,
      });
      await flush();
      maestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
      await flush();
      await flush();
    },
  },
  {
    name: '09-many-turns-overflow',
    description: 'Long history under tight viewport — scroll hint surfaces, latest turn pinned to bottom (auto-stick).',
    build: async ({ harness, maestro }) => {
      // ink-testing-library reports a small height under useBoxMetrics,
      // which `MessageList` slices via `Math.floor(height/3)`. The
      // result: only the last turn is visible plus the `↑ N above`
      // muted-gray hint. This scenario exercises auto-stick + the
      // overflow indicator, NOT all-8-turns-visible. (For that, a
      // future harness would need to mock zero metrics.)
      for (let i = 0; i < 8; i += 1) {
        harness.push(`question ${i + 1}`);
        await flush();
        await flush();
        maestro.emit({ type: 'turn_started' });
        await flush();
        maestro.emit({ type: 'assistant_text', text: `answer ${i + 1}` });
        await flush();
        maestro.emit({ type: 'turn_completed', isError: false, resultText: '' });
        await flush();
      }
      await flush();
    },
  },
  {
    name: '10-tool-summary-truncation',
    description: 'Long file_path summary truncates at 60 chars with ellipsis.',
    build: async ({ harness, maestro }) => {
      harness.push('Read deep path');
      await flush();
      await flush();
      maestro.emit({ type: 'turn_started' });
      await flush();
      maestro.emit({
        type: 'tool_use',
        callId: 'c1',
        name: 'Read',
        input: {
          file_path:
            '/some/very/long/path/that/keeps/going/and/wraps/around/the/budget/and/then/some.ts',
        },
      });
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
    '# Phase 3B.2 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the ChatPanel under a 3B.2 canonical state.',
    'Inspect `.plain.txt` for human-readable review;',
    '`.ansi.txt` keeps the color escapes (grep `\\x1b[38;2;…m` for hex codes).',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3b2-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3b2-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(
    path.join(OUT_DIR, 'INDEX-3b2.md'),
    summary.join('\n') + '\n',
    'utf8',
  );
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
