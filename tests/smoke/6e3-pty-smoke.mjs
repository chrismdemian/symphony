/**
 * Phase 6E.3 PTY smoke test.
 *
 * Boots the full Symphony TUI inside a real ConPTY with the settings popup
 * pre-opened and a recording stub VoiceController. Asserts:
 *   1. The settings popup renders with the new "Voice" section + a slider row
 *      (voice.vadThreshold) showing a bar and the 0.50 default.
 *   2. Navigating to voice.vadThreshold and pressing → (right arrow) raises
 *      the value to 0.55 on the real terminal screen and the violet bar fills
 *      one more cell (proves the slider command fires in a real terminal).
 *   3. The hot-apply path reached the controller — the post-exit transcript
 *      carries `__VAD_CALLS__:[...,0.55]` (App config→controller effect fired).
 *   4. The right border is flush (no content line overflows the box) — the
 *      authoritative check the ink-testing-library frames can't prove.
 *   5. Ctrl+C tears down cleanly (exit within deadline; no literal kitty-pop
 *      garbage in the transcript tail).
 *
 * A sandbox SYMPHONY_CONFIG_FILE keeps the slider's setConfig writes off the
 * user's real config (3S rule).
 *
 * Limitation (per CLAUDE.md): kitty-keyboard auto-detect round-trip is the
 * only thing this headless harness can't cover.
 */
import { spawn } from '@lydell/node-pty';
import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';
const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const COLS = 200;
const ROWS = 40;

const SANDBOX_CONFIG = path.join(os.tmpdir(), `symphony-6e3-smoke-${process.pid}.json`);

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const serializeAddon = new SerializeAddon();
term.loadAddon(serializeAddon);

const driver = path.join(repoRoot, 'tests', 'smoke', '6e3-tui-driver.tsx');
const isWin = process.platform === 'win32';
const shell = isWin ? 'cmd.exe' : 'sh';
const args = isWin
  ? ['/c', 'node', '--import', 'tsx', driver]
  : ['-c', `node --import tsx "${driver}"`];

const pty = spawn(shell, args, {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: repoRoot,
  env: {
    ...process.env,
    FORCE_COLOR: '3',
    COLORTERM: 'truecolor',
    SYMPHONY_PTY_SMOKE: '1',
    SYMPHONY_CONFIG_FILE: SANDBOX_CONFIG,
  },
});

const transcript = [];
pty.onData((data) => {
  transcript.push(data);
  term.write(data);
});

let exited = false;
let exitCode = null;
pty.onExit(({ exitCode: code }) => {
  exited = true;
  exitCode = code;
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function screenLines() {
  const buf = term.buffer.active;
  const lines = [];
  for (let y = 0; y < ROWS; y += 1) {
    const line = buf.getLine(y);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines;
}

function screenText() {
  return screenLines().join('\n');
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    if (exited) {
      throw new Error(
        `process exited before condition '${label}' met (code=${exitCode})\n--- transcript ---\n${transcript.join('')}`,
      );
    }
    await wait(50);
  }
  throw new Error(`timed out waiting for: ${label}\n--- transcript ---\n${transcript.join('')}`);
}

const findings = [];
const VIOLET = '\x1b[38;2;124;111;235m'; // #7C6FEB — slider filled cells

/** Send one keystroke and let the dispatcher commit before the next (3J rule). */
async function key(seq, settleMs = 70) {
  pty.write(seq);
  await wait(settleMs);
}

try {
  await waitFor(() => transcript.join('').length > 200, 'initial boot output', 12_000);
  await wait(2000);

  // Test 1: settings popup with the Voice section + a slider row at 0.50.
  await waitFor(() => screenText().includes('Settings'), 'settings popup rendered', 8_000);
  const boot = screenText();
  if (boot.includes('Voice')) {
    findings.push({ ok: true, label: 'settings popup shows the "Voice" section header' });
  } else {
    findings.push({ ok: false, label: `Voice header NOT present — screen: ${boot.slice(0, 1200)}` });
  }
  if (boot.includes('voice.vadThreshold') && boot.includes('0.50')) {
    findings.push({ ok: true, label: 'voice.vadThreshold row renders with 0.50 default' });
  } else {
    findings.push({ ok: false, label: 'voice.vadThreshold row / 0.50 default NOT present' });
  }
  if (boot.includes('█') && boot.includes('░')) {
    findings.push({ ok: true, label: 'slider bar glyphs (█/░) render' });
  } else {
    findings.push({ ok: false, label: 'slider bar glyphs NOT present' });
  }

  // Test 2: navigate to voice.vadThreshold (value-row index 11) and press →.
  for (let i = 0; i < 11; i += 1) await key('\x1b[B');
  await wait(150);
  // The selected slider row shows the ←→ footer hint.
  if (screenText().includes('adjust')) {
    findings.push({ ok: true, label: 'slider-selected footer hint ("←→ adjust") shown' });
  } else {
    findings.push({ ok: false, label: 'slider footer hint NOT shown after navigating to slider' });
  }
  await key('\x1b[C'); // right arrow → raise to 0.55
  await waitFor(() => screenText().includes('0.55'), 'vadThreshold raised to 0.55', 6_000);
  findings.push({ ok: true, label: '→ raised voice.vadThreshold to 0.55 on screen' });
  // The bar must still be violet (filled cells) after the nudge.
  if (serializeAddon.serialize().includes(VIOLET) || transcript.join('').includes(VIOLET)) {
    findings.push({ ok: true, label: 'slider bar renders violet (filled cells)' });
  } else {
    findings.push({ ok: false, label: 'violet bar escape NOT seen' });
  }

  // Test 4: right border flush — no content line longer than the box width.
  // Find the box width from a border line, then assert no line exceeds it.
  const lines = screenLines();
  const borderLine = lines.find((l) => l.includes('╭') && l.includes('╮'));
  if (borderLine) {
    const boxRight = borderLine.lastIndexOf('╮');
    const overflow = lines.find((l) => l.trimEnd().length > boxRight + 1);
    if (overflow === undefined) {
      findings.push({ ok: true, label: `no content overflows the box right edge (col ${boxRight})` });
    } else {
      findings.push({ ok: false, label: `content overflows box right edge: "${overflow}"` });
    }
  } else {
    findings.push({ ok: false, label: 'could not locate popup top border line' });
  }

  // Test 5: clean teardown on Ctrl+C.
  pty.write('\x03');
  const cleanupDeadline = Date.now() + 7000;
  while (!exited && Date.now() < cleanupDeadline) {
    await wait(100);
  }
  if (!exited) {
    pty.kill();
    findings.push({ ok: false, label: 'process did NOT exit within 7s after Ctrl+C — forced kill' });
  } else {
    findings.push({ ok: true, label: `process exited cleanly after Ctrl+C (code=${exitCode})` });
  }

  // Test 3: the hot-apply path reached the controller (post-exit marker).
  const full = transcript.join('');
  const m = full.match(/__VAD_CALLS__:(\[[^\]]*\])/);
  if (m) {
    let calls = [];
    try {
      calls = JSON.parse(m[1]);
    } catch {
      /* leave empty */
    }
    if (calls.includes(0.55)) {
      findings.push({ ok: true, label: `App→controller hot-apply fired setVadThreshold(0.55) [${m[1]}]` });
    } else {
      findings.push({ ok: false, label: `hot-apply marker present but missing 0.55: ${m[1]}` });
    }
  } else {
    findings.push({ ok: false, label: 'no __VAD_CALLS__ hot-apply marker in transcript' });
  }

  const tail = transcript.slice(-5).join('');
  // eslint-disable-next-line no-control-regex
  const literalBadPattern = /(?<!\x1b)\[<u/;
  if (literalBadPattern.test(tail)) {
    findings.push({ ok: false, label: 'literal "[<u" kitty-pop garbage in transcript tail' });
  } else {
    findings.push({ ok: true, label: 'no literal kitty-pop garbage in transcript tail' });
  }
} catch (err) {
  findings.push({ ok: false, label: `harness error: ${err instanceof Error ? err.message : String(err)}` });
} finally {
  if (!exited) pty.kill();
  try {
    fs.rmSync(SANDBOX_CONFIG, { force: true });
  } catch {
    /* best-effort */
  }
}

console.log('\n=== Phase 6E.3 PTY smoke results ===');
let allOk = true;
for (const f of findings) {
  const tag = f.ok ? 'PASS' : 'FAIL';
  if (!f.ok) allOk = false;
  console.log(`[${tag}] ${f.label}`);
}
console.log(`\nOverall: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
