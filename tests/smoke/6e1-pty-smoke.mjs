/**
 * Phase 6E.1 PTY smoke test.
 *
 * Boots the full Symphony TUI inside a real ConPTY with a STUB
 * VoiceController (no real Python / mic). Asserts:
 *   1. App launches without crash; the status bar renders (no voice chip
 *      while the session is off).
 *   2. `Ctrl+G` (`\x07`) toggles a listening session → the "● Listening"
 *      chip appears in the status bar, rendered in the locked violet
 *      accent (`\x1b[38;2;124;111;235m`).
 *   3. A second `Ctrl+G` toggles back off → the listening chip disappears.
 *   4. Ctrl+C tears down cleanly (exit within the launcher deadline, no
 *      literal kitty-pop garbage in the transcript tail).
 *
 * The stub flips its snapshot synchronously on `toggle()`, so this is a
 * pure chip-toggle assertion — no venv required. If the env lacks a venv,
 * the smoke still passes because no real bridge is spawned.
 *
 * Limitation (per CLAUDE.md): kitty-keyboard auto-detect round-trip is
 * the only thing this headless harness can't cover.
 */
import { spawn } from '@lydell/node-pty';
import xtermHeadless from '@xterm/headless';
import xtermSerialize from '@xterm/addon-serialize';
const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermSerialize;
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const COLS = 120;
const ROWS = 36;

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const serializeAddon = new SerializeAddon();
term.loadAddon(serializeAddon);

const driver = path.join(repoRoot, 'tests', 'smoke', '6e1-tui-driver.tsx');
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
const VIOLET = '\x1b[38;2;124;111;235m';

try {
  await waitFor(() => transcript.join('').length > 200, 'initial boot output', 12_000);
  // Let Ink mount + the status bar render.
  await wait(2500);

  // Test 1: app launched; status bar present; no voice chip while off.
  const beforeToggle = screenText();
  if (beforeToggle.includes('Symphony') && beforeToggle.includes('Notify')) {
    findings.push({ ok: true, label: 'status bar rendered (Symphony + tier chip)' });
  } else {
    findings.push({
      ok: false,
      label: `status bar NOT rendered — first 800: ${beforeToggle.slice(0, 800)}`,
    });
  }
  if (!beforeToggle.includes('Listening')) {
    findings.push({ ok: true, label: 'no voice chip while session is off (baseline)' });
  } else {
    findings.push({ ok: false, label: 'voice chip present before any Ctrl+G' });
  }

  // Test 2: Ctrl+G (\x07) → listening chip appears, in violet accent.
  pty.write('\x07');
  await waitFor(() => screenText().includes('Listening'), 'listening chip after Ctrl+G', 6_000);
  const snapOn = serializeAddon.serialize();
  if (snapOn.includes(VIOLET) || transcript.join('').includes(VIOLET)) {
    findings.push({ ok: true, label: 'Ctrl+G → listening chip in violet accent' });
  } else {
    findings.push({
      ok: false,
      label: 'listening chip present but violet accent escape NOT seen',
    });
  }

  // Test 3: second Ctrl+G → chip disappears.
  pty.write('\x07');
  await waitFor(
    () => !screenText().includes('Listening'),
    'listening chip cleared after 2nd Ctrl+G',
    6_000,
  );
  findings.push({ ok: true, label: '2nd Ctrl+G → listening chip cleared (session off)' });

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
  findings.push({
    ok: false,
    label: `harness error: ${err instanceof Error ? err.message : String(err)}`,
  });
} finally {
  if (!exited) pty.kill();
}

if (process.env['SYMPHONY_PTY_DEBUG'] === '1') {
  console.log('\n=== captured screen ===');
  console.log(screenText());
}

console.log('\n=== Phase 6E.1 PTY smoke results ===');
let allOk = true;
for (const f of findings) {
  const tag = f.ok ? 'PASS' : 'FAIL';
  if (!f.ok) allOk = false;
  console.log(`[${tag}] ${f.label}`);
}
console.log(`\nOverall: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
