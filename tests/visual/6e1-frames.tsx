/**
 * Phase 6E.1 — visual frame harness for the voice summon mode surfaces.
 *
 * Captures the two TUI surfaces 6E.1 touches under canonical states for a
 * SEPARATE skeptical-subagent review:
 *   - StatusBar voice listening indicator at every voice status
 *     (off → no chip / starting / listening / transcribing / error)
 *   - StatusBar listening chip at a NARROW width (truncate-not-wrap guard)
 *   - InputBar empty (placeholder, control/contrast frame)
 *   - InputBar carrying a voice-injected transcript (review mode)
 *
 * Output: `.visual-frames/6e1-<state>.{ansi,plain}.txt` + `INDEX-6e1.md`.
 *
 * Locked palette under review (CLAUDE.md §Symphony palette):
 *   - violet/accent `#7C6FEB` → `\x1b[38;2;124;111;235m` (listening / starting / transcribing chip)
 *   - gold-light/warning `#E5C07B` (theme.warning) — voice error chip
 *   - muted gray `#888888` → `\x1b[38;2;136;136;136m` (stopping chip)
 *   - text light gray `#E0E0E0` → `\x1b[38;2;224;224;224m` (body text)
 *
 * Invariants to verify:
 *   - StatusBar at voiceStatus='off' (and undefined) renders NO voice chip,
 *     on ONE line, identical to the pre-6E.1 baseline bar.
 *   - 'starting' → "◌ Starting" / "○ Starting" (pulse) in violet accent.
 *   - 'listening' → "● Listening" / "○ Listening" (pulse) in violet accent.
 *   - 'transcribing' → steady "● Transcribing" in violet accent.
 *   - 'error' → "✗ Voice" in theme.warning (amber).
 *   - The voice chip renders AFTER the autonomy tier chip; the bar NEVER
 *     wraps to a second line (status-bar-never-wraps rule, 3M/3S) — at a
 *     narrow width the bar TRUNCATES on one line (the `listening-narrow`
 *     scenario is the regression guard).
 *   - InputBar empty shows the placeholder; InputBar with an injected
 *     transcript shows the transcript text inside the rounded border with
 *     the cursor at end.
 *
 * Width mechanism: the StatusBar scenarios render at the Symphony standard
 * 120 columns via a fixed-width wrapper `<Box width={120}>`. ink-testing-
 * library's fake stdout does NOT honor a columns override, so an explicit
 * wrapper width is the reliable knob (the 3m/3s/3t harnesses render plain
 * and accept ink-testing-library's narrower default — the wrapper here pins
 * a true 120 cols so the chip placement is observable without spurious wrap).
 * The narrow guard uses `<Box width={64}>`.
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { StatusBar } from '../../src/ui/layout/StatusBar.js';
import { InputBar } from '../../src/ui/panels/chat/InputBar.js';
import type { VoiceStatus } from '../../src/voice/voice-controller.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');

// Symphony standard status-bar render width (matches 3m/3s/3t harnesses).
const WIDTH = 120;
// Deliberately narrow width to prove the bar TRUNCATES on one line (no wrap).
const NARROW = 64;

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

interface BarScenario {
  readonly kind: 'bar';
  readonly name: string;
  readonly description: string;
  readonly voiceStatus?: VoiceStatus;
  readonly width?: number;
}

interface InputScenario {
  readonly kind: 'input';
  readonly name: string;
  readonly description: string;
  /** undefined → empty (placeholder) frame; otherwise the injected transcript. */
  readonly injectedText?: string;
}

type Scenario = BarScenario | InputScenario;

const SCENARIOS: readonly Scenario[] = [
  {
    kind: 'bar',
    name: '01-bar-voice-off',
    description:
      'StatusBar with voiceStatus="off" — NO voice chip renders (the chip self-suppresses for off/undefined). One line; identical to the pre-6E.1 baseline bar when no session is active.',
    voiceStatus: 'off',
  },
  {
    kind: 'bar',
    name: '02-bar-voice-undefined',
    description:
      'StatusBar with voiceStatus undefined (voice disabled / non-TTY) — NO voice chip. Pre-6E.1 baseline.',
  },
  {
    kind: 'bar',
    name: '03-bar-voice-starting',
    description:
      'StatusBar at voiceStatus="starting". Chip "◌ Starting" or "○ Starting" (pulse parity) in violet accent (`\\x1b[38;2;124;111;235m`), rendered AFTER the autonomy tier chip, on one line.',
    voiceStatus: 'starting',
  },
  {
    kind: 'bar',
    name: '04-bar-voice-listening',
    description:
      'StatusBar at voiceStatus="listening". Chip "● Listening" / "○ Listening" (pulse) in violet accent. Canonical mic-hot state. ONE line, chip glyph + label intact (no wrap).',
    voiceStatus: 'listening',
  },
  {
    kind: 'bar',
    name: '05-bar-voice-transcribing',
    description:
      'StatusBar at voiceStatus="transcribing". Chip "● Transcribing" — steady (no pulse) in violet accent.',
    voiceStatus: 'transcribing',
  },
  {
    kind: 'bar',
    name: '06-bar-voice-error',
    description:
      'StatusBar at voiceStatus="error". Chip "✗ Voice" in theme.warning (amber `#E5C07B`), distinct from the violet listening colorway.',
    voiceStatus: 'error',
  },
  {
    kind: 'bar',
    name: '08-bar-voice-listening-narrow',
    description:
      'StatusBar at voiceStatus="listening" rendered at a NARROW 64-col width. REGRESSION GUARD for the status-bar-never-wraps rule: the bar must TRUNCATE on a single line (clipping the voice chip at extreme narrow width is acceptable), never spill to a second line.',
    voiceStatus: 'listening',
    width: NARROW,
  },
  {
    kind: 'input',
    name: '09-input-empty',
    description:
      'InputBar empty — placeholder "Tell Maestro what to do…" inside the rounded border. Control/contrast frame for the injected scenario.',
  },
  {
    kind: 'input',
    name: '07-input-voice-injected',
    description:
      'InputBar with a voice-injected transcript (review mode). The transcript text appears inside the rounded border with the cursor at end — confirms the `injected` nonce channel routes a final into the buffer via insertChunk. Captured AFTER the injection nonce commits (microtask flush before lastFrame).',
    injectedText: 'open the pi pipeline and check the logs',
  },
];

async function captureBar(
  voiceStatus: VoiceStatus | undefined,
  width: number,
): Promise<{ ansi: string; plain: string }> {
  const tree = (
    <ThemeProvider>
      <Box width={width}>
        <StatusBar
          version="0.0.0"
          mode="plan"
          projects={[
            {
              id: 'p1',
              name: 'MathScrabble',
              path: '/repos/MathScrabble',
              createdAt: '2026-05-30T00:00:00.000Z',
            },
          ]}
          workers={[]}
          sessionId="abcd1234ef"
          questionsCount={0}
          blockingCount={0}
          autonomyTier={2}
          activeProject={null}
          {...(voiceStatus !== undefined ? { voiceStatus } : {})}
        />
      </Box>
    </ThemeProvider>
  );
  const result = render(tree);
  await flush();
  await flush();
  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

async function captureInput(
  injectedText: string | undefined,
): Promise<{ ansi: string; plain: string }> {
  // For the injected scenario, mount with the nonce already set so the
  // useEffect injection commits on the first effect pass; flush microtasks
  // BEFORE sampling so lastFrame() captures the post-injection buffer, not
  // the pre-injection placeholder. Empty scenario mounts with no injection.
  const injected =
    injectedText !== undefined ? { text: injectedText, nonce: 1 } : undefined;
  const tree = (
    <ThemeProvider>
      <Box width={WIDTH}>
        <InputBar
          onSubmit={() => undefined}
          isActive
          {...(injected !== undefined ? { injected } : {})}
        />
      </Box>
    </ThemeProvider>
  );
  const result = render(tree);
  // Drain effect + state-commit microtasks so the nonce-guarded injection
  // lands before we sample the frame (capture-timing fix for 6e1-07).
  await flush();
  await flush();
  await flush();
  const ansi = result.lastFrame() ?? '';
  const plain = stripAnsi(ansi);
  result.unmount();
  return { ansi, plain };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const summary: string[] = [
    '# Phase 6E.1 visual frames — Voice summon mode',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders one of:',
    '  - StatusBar (voice listening indicator across voice statuses; one narrow guard)',
    '  - InputBar (empty placeholder + voice-injected transcript, review mode)',
    '',
    'Inspect `.plain.txt` for human review; `.ansi.txt` keeps the color',
    'escapes for the skeptical-subagent grep pass.',
    '',
    'Locked palette under review (CLAUDE.md §Symphony palette):',
    '- violet/accent `#7C6FEB`  → `\\x1b[38;2;124;111;235m` (listening / starting / transcribing chip)',
    '- gold-light/warning `#E5C07B` (theme.warning) → voice error chip (amber)',
    '- muted gray `#888888`     → `\\x1b[38;2;136;136;136m` (stopping chip)',
    '- text light gray `#E0E0E0` → `\\x1b[38;2;224;224;224m` (body text)',
    '',
    'Invariants to verify:',
    '- voiceStatus off/undefined → NO voice chip (pre-6E.1 baseline bar), ONE line.',
    '- starting/listening/transcribing chip → violet accent escape present.',
    '- error chip → theme.warning (amber), NOT violet.',
    '- chip renders AFTER the `T2 Notify` autonomy tier chip.',
    '- the bar NEVER wraps; the narrow scenario TRUNCATES on one line.',
    '- InputBar empty shows the placeholder; injected shows the transcript text.',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    let captured: { ansi: string; plain: string };
    if (scenario.kind === 'bar') {
      captured = await captureBar(scenario.voiceStatus, scenario.width ?? WIDTH);
    } else {
      captured = await captureInput(scenario.injectedText);
    }
    writeFileSync(path.join(OUT_DIR, `6e1-${scenario.name}.ansi.txt`), captured.ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `6e1-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${captured.plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-6e1.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
