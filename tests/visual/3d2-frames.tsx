/**
 * Phase 3D.2 — visual frame harness.
 *
 * Captures the OutputPanel under canonical states for the json-render
 * integration: single spec, mixed narrative + spec, multiple back-to-back
 * specs, invalid JSON inside a fence, malformed spec shape, dense card
 * with metrics. Each scenario seeds a synthetic stream-event sequence
 * (via the same fake RPC pattern from 3D.1) whose `assistant_text`
 * carries the fence body, captures the rendered frame, dumps `.ansi`
 * (with escapes) + `.plain` (stripped) + `INDEX-3d2.md`.
 *
 * Output: `.visual-frames/3d2-<state>.{ansi,plain}.txt`.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { FocusProvider, useFocus, type FocusKey } from '../../src/ui/focus/focus.js';
import { KeybindProvider } from '../../src/ui/keybinds/dispatcher.js';
import { buildGlobalCommands } from '../../src/ui/keybinds/global.js';
import { WorkerSelectionProvider } from '../../src/ui/data/WorkerSelection.js';
import { OutputPanel } from '../../src/ui/panels/output/OutputPanel.js';
import type { TuiRpc } from '../../src/ui/runtime/rpc.js';
import type { StreamEvent } from '../../src/workers/types.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

interface SubscriptionEntry {
  workerId: string;
  listener: (e: unknown) => void;
  unsubscribed: boolean;
}

function makeFakeRpc(opts: {
  tailEvents?: StreamEvent[];
}): { rpc: TuiRpc; emit(workerId: string, e: StreamEvent): void } {
  const subs: SubscriptionEntry[] = [];
  const rpc: TuiRpc = {
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
        tail: async () => ({
          events: opts.tailEvents ?? [],
          total: opts.tailEvents?.length ?? 0,
        }),
      },
      questions: {
        list: async () => [],
        get: async () => null,
        answer: async () => {
          throw new Error('unused');
        },
      },
      waves: { list: async () => [], get: async () => null },
      mode: { get: async () => ({ mode: 'plan' as const }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    subscribe: (async (_topic: string, args: unknown, listener: (e: unknown) => void) => {
      const workerId = (args as { workerId: string }).workerId;
      const entry: SubscriptionEntry = { workerId, listener, unsubscribed: false };
      subs.push(entry);
      return {
        topic: 'workers.events',
        unsubscribe: async (): Promise<void> => {
          entry.unsubscribed = true;
        },
      };
    }) as unknown as TuiRpc['subscribe'],
    close: async () => {},
  };
  return {
    rpc,
    emit(workerId: string, event: StreamEvent): void {
      for (const sub of subs) {
        if (sub.workerId === workerId && !sub.unsubscribed) sub.listener(event);
      }
    },
  };
}

function FocusForcer({ to }: { readonly to: FocusKey }): React.JSX.Element {
  const focus = useFocus();
  // useRef gate per Phase 3D.1 audit — avoid infinite loop in test
  // harnesses that combine FocusProvider with useBoxMetrics.
  const fired = React.useRef(false);
  React.useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    focus.setMain(to);
  });
  return <></>;
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly initialSelectedId: string | null;
  readonly tailEvents?: StreamEvent[];
  readonly columns?: number;
  readonly rows?: number;
}

const text = (t: string): StreamEvent => ({ type: 'assistant_text', text: t });

/** Build a minimal fenced spec block inside an `assistant_text` body. */
function fenced(spec: Record<string, unknown>, leadIn: string, leadOut: string): string {
  return `${leadIn}\n\n\`\`\`json-render\n${JSON.stringify(spec)}\n\`\`\`\n\n${leadOut}`;
}

const SINGLE_CARD_SPEC = {
  root: 'card-1',
  elements: {
    'card-1': {
      type: 'Card',
      props: { title: 'Worker Status' },
      children: ['heading-1', 'text-1'],
    },
    'heading-1': { type: 'Heading', props: { text: 'All Tests Passing' } },
    'text-1': { type: 'Text', props: { text: '1317 / 1317 green' } },
  },
} as const;

const SECOND_CARD_SPEC = {
  root: 'card-2',
  elements: {
    'card-2': {
      type: 'Card',
      props: { title: 'Bundle Delta' },
      children: ['t-2'],
    },
    't-2': { type: 'Text', props: { text: '+18.4 KB (within 100 KB cap)' } },
  },
} as const;

const THIRD_CARD_SPEC = {
  root: 'card-3',
  elements: {
    'card-3': {
      type: 'Card',
      props: { title: 'Audit Verdict' },
      children: ['t-3'],
    },
    't-3': { type: 'Text', props: { text: 'PASS' } },
  },
} as const;

/** Dense Card{Heading + Stack(Metric x3)} demonstrating themed colors
 *  across multiple component types in a single render. */
const DENSE_DASHBOARD_SPEC = {
  root: 'dash',
  elements: {
    dash: {
      type: 'Card',
      props: { title: 'Build Health' },
      children: ['h-1', 'stack-1'],
    },
    'h-1': { type: 'Heading', props: { text: 'master @ feature/3d2-json-render' } },
    'stack-1': {
      type: 'Box',
      props: { flexDirection: 'row', gap: 4 },
      children: ['m-1', 'm-2', 'm-3'],
    },
    'm-1': {
      type: 'Metric',
      props: { label: 'Tests', value: '1317', trend: 'up' },
    },
    'm-2': {
      type: 'Metric',
      props: { label: 'Bundle (KB)', value: '478.8', trend: 'flat' },
    },
    'm-3': {
      type: 'Metric',
      props: { label: 'Coverage', value: '92%', trend: 'up' },
    },
  },
} as const;

const SCENARIOS: Scenario[] = [
  {
    name: '01-single-card',
    description:
      'A single ` ```json-render ` fence inside assistant_text → themed Card with violet border + gold heading.',
    initialSelectedId: 'w-1',
    tailEvents: [
      text(fenced(SINGLE_CARD_SPEC, "Here's the current status:", 'Continuing with the next task.')),
    ],
  },
  {
    name: '02-mixed-narrative',
    description:
      'Plain narrative interleaved with two render fences — typical worker output shape.',
    initialSelectedId: 'w-1',
    tailEvents: [
      text(
        [
          'I ran the test suite and verified the bundle delta. Summary:',
          '',
          '```json-render',
          JSON.stringify(SINGLE_CARD_SPEC),
          '```',
          '',
          'And the bundle metrics:',
          '',
          '```json-render',
          JSON.stringify(SECOND_CARD_SPEC),
          '```',
          '',
          'All checks pass.',
        ].join('\n'),
      ),
    ],
  },
  {
    name: '03-multiple-back-to-back-specs',
    description:
      'Three render fences with no plain text between them (whitespace-only segments dropped).',
    initialSelectedId: 'w-1',
    tailEvents: [
      text(
        [
          '```json-render',
          JSON.stringify(SINGLE_CARD_SPEC),
          '```',
          '',
          '```json-render',
          JSON.stringify(SECOND_CARD_SPEC),
          '```',
          '',
          '```json-render',
          JSON.stringify(THIRD_CARD_SPEC),
          '```',
        ].join('\n'),
      ),
    ],
  },
  {
    name: '04-invalid-json',
    description:
      'Fence body is malformed JSON → red ⚠ fallback row + truncated raw body in muted gray.',
    initialSelectedId: 'w-1',
    tailEvents: [
      text(
        [
          'Attempting to render:',
          '',
          '```json-render',
          '{not actually json — missing quotes and braces',
          '```',
          '',
          'Falling back to plain output.',
        ].join('\n'),
      ),
    ],
  },
  {
    name: '05-spec-shape-fail',
    description:
      'Valid JSON but wrong shape (missing root) → fallback row with explanation.',
    initialSelectedId: 'w-1',
    tailEvents: [
      text(
        [
          'Trying with no root:',
          '',
          '```json-render',
          JSON.stringify({ elements: { x: { type: 'Text', props: { text: 'orphan' } } } }),
          '```',
          '',
          'Continuing.',
        ].join('\n'),
      ),
    ],
  },
  {
    name: '06-unknown-component',
    description:
      'Spec references a component type the registry has no entry for → @json-render/ink renders nothing for that element; surrounding plain text + sibling specs still render.',
    initialSelectedId: 'w-1',
    tailEvents: [
      text(
        [
          'Trying an unknown component (the renderer emits a console.warn and renders nothing for it):',
          '',
          '```json-render',
          JSON.stringify({
            root: 'r',
            elements: { r: { type: 'NotARealComponent', props: {} } },
          }),
          '```',
          '',
          'But sibling specs still render normally:',
          '',
          '```json-render',
          JSON.stringify(THIRD_CARD_SPEC),
          '```',
          '',
          'Continuing.',
        ].join('\n'),
      ),
    ],
  },
  {
    name: '07-dense-dashboard',
    description:
      'Dense Card{Heading + Box-row{Metric x3}} — exercises violet border, gold heading, light text + muted metric labels in one render.',
    initialSelectedId: 'w-1',
    tailEvents: [
      text(fenced(DENSE_DASHBOARD_SPEC, 'Build health snapshot:', 'Will keep monitoring.')),
    ],
    rows: 35,
  },
];

interface CapturedFrame {
  ansi: string;
  plain: string;
}

async function captureScenario(scenario: Scenario): Promise<CapturedFrame> {
  const handle = makeFakeRpc({
    ...(scenario.tailEvents !== undefined ? { tailEvents: scenario.tailEvents } : {}),
  });
  const rows = scenario.rows ?? 30;
  const columns = scenario.columns ?? 100;

  const tree = (
    <Box flexDirection="column" height={rows} width={columns}>
      <ThemeProvider>
        <FocusProvider>
          <FocusForcer to="output" />
          <KeybindProvider
            initialCommands={buildGlobalCommands({
              cycleFocus: () => {},
              cycleFocusReverse: () => {},
              requestExit: () => {},
              showHelp: () => {},
            })}
          >
            <WorkerSelectionProvider initialSelectedId={scenario.initialSelectedId}>
              <OutputPanel rpc={handle.rpc} />
            </WorkerSelectionProvider>
          </KeybindProvider>
        </FocusProvider>
      </ThemeProvider>
    </Box>
  );

  const result = render(tree);
  await flush();
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
    '# Phase 3D.2 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the OutputPanel with assistant_text events that contain ` ```json-render ` fences.',
    'Inspect `.plain.txt` for human-readable review;',
    '`.ansi.txt` keeps the color escapes (grep `\\x1b[38;2;…m` for hex codes).',
    '',
    'Palette tokens introduced in 3D.2 (all refs to existing palette — no new hex codes):',
    '- `jsonRenderBorder` → violet `#7C6FEB` → `\\x1b[38;2;124;111;235m`',
    '- `jsonRenderHeading` → gold `#D4A843` → `\\x1b[38;2;212;168;67m`',
    '- `jsonRenderText` → text-light `#E0E0E0` → `\\x1b[38;2;224;224;224m`',
    '- `jsonRenderMuted` → muted gray `#888888` → `\\x1b[38;2;136;136;136m`',
    '- `jsonRenderError` → red `#E06C75` → `\\x1b[38;2;224;108;117m`',
    '',
    'Fence detection:',
    '- ` ```json-render ` (CRLF-aware) → spec body parsed as JSON; rendered via `<JsonRenderBlock>`',
    '- valid spec shape → `<Renderer registry={SYMPHONY_JSON_RENDER_REGISTRY}/>` with violet border + gold heading',
    '- invalid JSON → `<FallbackPlainText>` with `⚠ json-render block failed: <reason>` + truncated raw body in muted gray',
    '- invalid shape (missing root etc.) → same fallback shape, no exception thrown',
    '- unknown component type → @json-render/ink emits null for that element + console.warn (not visible in panel; sibling content renders normally)',
    '',
    'Scope (per PLAN.md §3D.2):',
    '- 3D.2 handles ONLY ` ```json-render ` fences inside `assistant_text`.',
    '- `structured_completion.display` field is deferred to Phase 4E.',
    '- The completion-report ` ```json ` fence (different prefix) is server-side parsed in `stream-parser.ts`; 3D.2 does not touch it.',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3d2-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3d2-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3d2.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
