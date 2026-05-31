/**
 * Phase 6E.2 — always-capture voice indicator frames.
 *
 * Captures the StatusBar voice chip across the always-mode summon states so
 * a SEPARATE skeptical-subagent can verify the GOLD `◉ Summoned` chip
 * (#D4A843 → `\x1b[38;2;212;168;67m`) is DISTINCT from the VIOLET ambient
 * `● Listening` / `● Transcribing` chip (#7C6FEB → `\x1b[38;2;124;111;235m`).
 * An armed summon takes visual priority over the underlying status.
 *
 * Output: `.visual-frames/6e2-<state>.{ansi,plain}.txt` + `INDEX-6e2.md`.
 * Mirrors the 6E.1 harness (self-contained; inline write; theme/context.js).
 */
import React from 'react';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { StatusBar } from '../../src/ui/layout/StatusBar.js';
import type { VoiceStatus } from '../../src/voice/voice-controller.js';

const OUT_DIR = path.resolve(process.cwd(), '.visual-frames');
const WIDTH = 120;

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly voiceStatus: VoiceStatus;
  readonly voiceSummoned: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: '01-ambient-listening',
    description:
      'always mode, ambient: voiceStatus="listening", summoned=false → VIOLET "● Listening" chip (accent `\\x1b[38;2;124;111;235m`). NOT gold, NOT "Summoned".',
    voiceStatus: 'listening',
    voiceSummoned: false,
  },
  {
    name: '02-summoned',
    description:
      'always mode, ARMED: voiceStatus="listening", summoned=true → GOLD "◉ Summoned" chip (`\\x1b[38;2;212;168;67m`). Summon priority over the ambient listening label.',
    voiceStatus: 'listening',
    voiceSummoned: true,
  },
  {
    name: '03-summoned-transcribing',
    description:
      'always mode, ARMED + capturing the summon utterance: voiceStatus="transcribing", summoned=true → GOLD "◉ Summoned" (summon priority over "Transcribing").',
    voiceStatus: 'transcribing',
    voiceSummoned: true,
  },
  {
    name: '04-transcribing-not-summoned',
    description:
      'always mode, ambient capture: voiceStatus="transcribing", summoned=false → VIOLET "● Transcribing" (NOT gold).',
    voiceStatus: 'transcribing',
    voiceSummoned: false,
  },
  {
    name: '05-starting',
    description:
      'always mode bootstrapping: voiceStatus="starting", summoned=false → VIOLET starting chip.',
    voiceStatus: 'starting',
    voiceSummoned: false,
  },
  {
    name: '06-error',
    description:
      'voiceStatus="error" → RED "✗ Voice" (theme.warning amber `#E5C07B`), distinct from gold + violet.',
    voiceStatus: 'error',
    voiceSummoned: false,
  },
];

async function capture(scenario: Scenario): Promise<{ ansi: string; plain: string }> {
  const tree = (
    <ThemeProvider>
      <Box width={WIDTH}>
        <StatusBar
          version="0.0.0"
          mode="plan"
          projects={[
            {
              id: 'p1',
              name: 'MathScrabble',
              path: '/repos/MathScrabble',
              createdAt: '2026-05-31T00:00:00.000Z',
            },
          ]}
          workers={[]}
          sessionId="abcd1234ef"
          questionsCount={0}
          blockingCount={0}
          autonomyTier={2}
          activeProject={null}
          voiceStatus={scenario.voiceStatus}
          voiceSummoned={scenario.voiceSummoned}
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

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const summary: string[] = [
    '# Phase 6E.2 visual frames — always-capture voice indicator',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Each scenario renders the StatusBar voice chip in an always-mode state.',
    'Inspect `.plain.txt` for the label; grep `.ansi.txt` for color escapes.',
    '',
    'Palette under review:',
    '- gold `#D4A843` → `\\x1b[38;2;212;168;67m` (◉ Summoned)',
    '- violet `#7C6FEB` → `\\x1b[38;2;124;111;235m` (● Listening / Transcribing / Starting)',
    '- amber warning `#E5C07B` (theme.warning) → ✗ Voice (error)',
    '',
    'Invariants:',
    '- summoned=true → GOLD "◉ Summoned" (frames 02, 03), priority over listening/transcribing.',
    '- summoned=false → VIOLET ambient chip (frames 01, 04, 05).',
    '- error → amber "✗ Voice".',
    '- the bar renders on ONE line (no wrap).',
    '',
    '| Scenario | Description |',
    '|---|---|',
  ];

  for (const scenario of SCENARIOS) {
    process.stderr.write(`Capturing ${scenario.name}…\n`);
    const { ansi, plain } = await capture(scenario);
    writeFileSync(path.join(OUT_DIR, `6e2-${scenario.name}.ansi.txt`), ansi, 'utf8');
    writeFileSync(
      path.join(OUT_DIR, `6e2-${scenario.name}.plain.txt`),
      `# ${scenario.name}\n# ${scenario.description}\n\n${plain}\n`,
      'utf8',
    );
    summary.push(`| \`${scenario.name}\` | ${scenario.description} |`);
  }

  writeFileSync(path.join(OUT_DIR, 'INDEX-6e2.md'), summary.join('\n') + '\n', 'utf8');
  process.stderr.write(`\n${SCENARIOS.length} frames written to ${OUT_DIR}\n`);
}

void main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
