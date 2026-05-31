/**
 * Phase 6E.2 PTY smoke test.
 *
 * Boots the full Symphony TUI inside a real ConPTY with an always-mode STUB
 * VoiceController (no real Python / mic / SQLite). Asserts:
 *   1. App launches; the status bar renders; the ambient VIOLET "● Listening"
 *      chip is present at boot (always mode runs continuously).
 *   2. `Ctrl+G` (`\x07`) arms a summon → the GOLD "◉ Summoned" chip appears,
 *      rendered in the locked brand gold (`\x1b[38;2;212;168;67m`).
 *   3. A second `Ctrl+G` disarms → back to the ambient "Listening" chip.
 *   4. Ctrl+C tears down cleanly (exit within the launcher deadline, no
 *      literal kitty-pop garbage in the transcript tail).
 *
 * A sandbox SYMPHONY_CONFIG_FILE keeps the away-mode `setConfig` fired by the
 * 6E.2 ownership effect (alwaysActive=true) off the user's real config (3S rule).
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
const ROWS = 36;

const SANDBOX_CONFIG = path.join(os.tmpdir(), `symphony-6e2-smoke-${process.pid}.json`);

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const serializeAddon = new SerializeAddon();
term.loadAddon(serializeAddon);

const driver = path.join(repoRoot, 'tests', 'smoke', '6e2-tui-driver.tsx');
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

function screenText() {
  const buf = term.buffer.active;
  let plain = '';
  for (let y = 0; y < ROWS; y += 1) {
    const line = buf.getLine(y);
    if (line) plain += line.translateToString(true) + '\n';
  }
  return plain;
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
const GOLD = '\x1b[38;2;212;168;67m'; // #D4A843 Summoned
const VIOLET = '\x1b[38;2;124;111;235m'; // #7C6FEB ambient

try {
  await waitFor(() => transcript.join('').length > 200, 'initial boot output', 12_000);
  await wait(2500);

  // Test 1: app launched; status bar present; ambient listening chip at boot.
  const boot = screenText();
  if (boot.includes('Symphony') && boot.includes('Notify')) {
    findings.push({ ok: true, label: 'status bar rendered (Symphony + tier chip)' });
  } else {
    findings.push({ ok: false, label: `status bar NOT rendered — first 800: ${boot.slice(0, 800)}` });
  }
  if (boot.includes('Listening')) {
    findings.push({ ok: true, label: 'always mode boots with the ambient "Listening" chip' });
  } else {
    findings.push({ ok: false, label: 'ambient Listening chip NOT present at boot' });
  }
  if (!boot.includes('Summoned')) {
    findings.push({ ok: true, label: 'not summoned at boot (no gold chip)' });
  } else {
    findings.push({ ok: false, label: 'Summoned chip present before any Ctrl+G' });
  }

  // Test 2: Ctrl+G arms a summon → gold "Summoned" chip.
  pty.write('\x07');
  await waitFor(() => screenText().includes('Summoned'), 'Summoned chip after Ctrl+G', 6_000);
  const summoned = serializeAddon.serialize();
  if (summoned.includes(GOLD) || transcript.join('').includes(GOLD)) {
    findings.push({ ok: true, label: 'Ctrl+G → gold "◉ Summoned" chip' });
  } else {
    findings.push({ ok: false, label: 'Summoned chip present but GOLD accent escape NOT seen' });
  }

  // Test 3: second Ctrl+G disarms → back to ambient Listening (no Summoned).
  pty.write('\x07');
  await waitFor(
    () => !screenText().includes('Summoned'),
    'Summoned chip cleared after 2nd Ctrl+G',
    6_000,
  );
  const disarmed = screenText();
  if (disarmed.includes('Listening')) {
    findings.push({ ok: true, label: '2nd Ctrl+G → disarmed, back to ambient Listening' });
  } else {
    findings.push({ ok: false, label: 'after disarm, ambient Listening chip NOT restored' });
  }
  // Sanity: the ambient chip is violet (not gold) once disarmed.
  if (serializeAddon.serialize().includes(VIOLET)) {
    findings.push({ ok: true, label: 'ambient chip is violet after disarm' });
  } else {
    findings.push({ ok: false, label: 'violet accent escape NOT seen after disarm' });
  }

  // Test 4: clean teardown on Ctrl+C.
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

console.log('\n=== Phase 6E.2 PTY smoke results ===');
let allOk = true;
for (const f of findings) {
  const tag = f.ok ? 'PASS' : 'FAIL';
  if (!f.ok) allOk = false;
  console.log(`[${tag}] ${f.label}`);
}
console.log(`\nOverall: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
