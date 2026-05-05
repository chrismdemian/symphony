/**
 * Phase 3F.2 — visual frame harness for leader-key plumbing.
 *
 * Captures canonical states:
 *   01-toast-info        single info-tone toast in tray
 *   02-toast-stack       three stacked toasts in tray (info/success/warning)
 *   03-bar-leader-armed  KeybindBar showing the `Ctrl+X _` armed hint
 *   04-bar-idle          KeybindBar idle (no leader armed) for comparison
 *
 * `.visual-frames/3f2-<state>.{ansi,plain}.txt` + `INDEX-3f2.md`.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { ToastProvider, useToast, type Toast } from '../../src/ui/feedback/ToastProvider.js';
import { ToastTray } from '../../src/ui/feedback/ToastTray.js';
import { useTheme } from '../../src/ui/theme/context.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly element: React.JSX.Element;
}

function FireToasts({
  toasts,
}: {
  readonly toasts: ReadonlyArray<{
    readonly message: string;
    readonly tone?: Toast['tone'];
  }>;
}): null {
  const { showToast } = useToast();
  React.useEffect(() => {
    for (const t of toasts) {
      showToast(t.message, { ttlMs: 5000, ...(t.tone !== undefined ? { tone: t.tone } : {}) });
    }
  }, []);
  return null;
}

/**
 * Mock KeybindBar — uses theme + a hard-coded armed/idle state.
 * (We can't easily render the real KeybindBar in this harness because
 * it requires the dispatcher's full context tree.)
 */
function MockBar({ armed }: { readonly armed: boolean }): React.JSX.Element {
  const theme = useTheme();
  if (armed) {
    return (
      <Box flexDirection="row" paddingX={1}>
        <Text color={theme['accent']} bold>
          Ctrl+X
        </Text>
        <Text color={theme['textMuted']}> _ </Text>
        <Text color={theme['textMuted']}>
          m: switch model mode  ·  p: switch project  ·  t: toggle theme
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="row" paddingX={1}>
      <Text color={theme['textMuted']}>
        Tab: next panel  Ctrl+C: exit  Ctrl+P: command palette  ?: help
      </Text>
    </Box>
  );
}

const SCENARIOS: Scenario[] = [
  {
    name: '01-toast-info',
    description: 'Single info-tone toast — violet `●` marker + light-gray body text.',
    element: (
      <ToastProvider>
        <ToastTray />
        <FireToasts
          toasts={[{ message: 'Model mode switch — Phase 3H will wire the real action.' }]}
        />
      </ToastProvider>
    ),
  },
  {
    name: '02-toast-stack',
    description:
      'Three stacked toasts: info / success / warning. Each line gets its own tone marker.',
    element: (
      <ToastProvider>
        <ToastTray />
        <FireToasts
          toasts={[
            { message: 'Project switch — Phase 5 will wire the real action.', tone: 'info' },
            { message: 'Theme toggle ready.', tone: 'success' },
            { message: 'Model unavailable in this region.', tone: 'warning' },
          ]}
        />
      </ToastProvider>
    ),
  },
  {
    name: '03-bar-leader-armed',
    description:
      'KeybindBar with leader armed — `Ctrl+X _` violet bold + muted "(waiting for second key…)" hint.',
    element: <MockBar armed />,
  },
  {
    name: '04-bar-idle',
    description: 'KeybindBar idle (no leader armed) — regular space-separated key:title pairs in muted gray.',
    element: <MockBar armed={false} />,
  },
];

interface CapturedFrame {
  readonly ansi: string;
  readonly plain: string;
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
}

async function captureScenario(scenario: Scenario): Promise<CapturedFrame> {
  const result = render(
    <Box flexDirection="column" width={100}>
      <ThemeProvider>{scenario.element}</ThemeProvider>
    </Box>,
  );
  await flushAll();
  await new Promise((r) => setTimeout(r, 50));
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
    '# Phase 3F.2 visual frames',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Toast tray + KeybindBar leader-armed states.',
    '',
    'Palette referenced (locked):',
    '- `accent` (info-toast `●`, leader-armed bar `Ctrl+X _` bold) → violet `#7C6FEB` → `\\x1b[38;2;124;111;235m`',
    '- `success` (success-toast `●`) → gold `#D4A843` → `\\x1b[38;2;212;168;67m`',
    '- `warning` (warning-toast `●`) → gold-light `#E5C07B` → `\\x1b[38;2;229;192;123m`',
    '- `error` (error-toast `●`) → red `#E06C75` → `\\x1b[38;2;224;108;117m`',
    '- `text` (toast body) → light gray `#E0E0E0` → `\\x1b[38;2;224;224;224m`',
    '- `textMuted` (idle bar contents, leader hint suffix) → muted `#888888` → `\\x1b[38;2;136;136;136m`',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await captureScenario(scenario);
    writeFileSync(path.join(OUT_DIR, `3f2-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `3f2-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-3f2.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
