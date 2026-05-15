/**
 * Phase 3R PTY smoke test.
 *
 * Boots the 3R driver inside a real ConPTY, opens the audit-log popup
 * via `/log`, types an inline filter, and asserts:
 *   1. App launches without crash (status bar visible).
 *   2. `/log` + Enter opens the LogPanel ("Audit log" title + a canned
 *      entry headline visible).
 *   3. Truecolor escapes present (violet border/title).
 *   4. Typing `--type merge` updates the filter row.
 *   5. Esc closes the popup (back to chat).
 *   6. Ctrl+C teardown completes cleanly (no kitty pop garbage).
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
const ROWS = 30;

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const serializeAddon = new SerializeAddon();
term.loadAddon(serializeAddon);

const driver = path.join(repoRoot, 'tests', 'smoke', '3r-tui-driver.tsx');
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

function snapshotPlain() {
  const buf = term.buffer.active;
  let plain = '';
  for (let y = 0; y < ROWS; y += 1) {
    const line = buf.getLine(y);
    if (line) plain += line.translateToString(true) + '\n';
  }
  return plain;
}

const findings = [];
const VIOLET = '\x1b[38;2;124;111;235m';

try {
  await wait(4000);

  const bootPlain = snapshotPlain();
  if (bootPlain.includes('Mode:')) {
    findings.push({ ok: true, label: 'status bar rendered (Mode: segment visible)' });
  } else {
    findings.push({
      ok: false,
      label: `status bar NOT visible — first 600 chars: ${bootPlain.slice(0, 600)}`,
    });
  }

  // Open the audit-log popup: type "/log" then Enter (separate writes
  // per the 3J gotcha — ink treats multi-char chunks as paste).
  pty.write('/log');
  await wait(150);
  pty.write('\r');
  await wait(1200);

  const logPlain = snapshotPlain();
  if (logPlain.includes('Audit log')) {
    findings.push({ ok: true, label: 'LogPanel opened ("Audit log" title visible)' });
  } else {
    findings.push({
      ok: false,
      label: `LogPanel did NOT open — screen: ${logPlain.slice(0, 600)}`,
    });
  }

  if (logPlain.includes('merged feature/friend-list') || logPlain.includes('completed: add friend-list')) {
    findings.push({ ok: true, label: 'canned audit entry headline visible in popup' });
  } else {
    findings.push({
      ok: false,
      label: `audit entries NOT visible — screen: ${logPlain.slice(0, 600)}`,
    });
  }

  const logSerialized = serializeAddon.serialize();
  if (logSerialized.includes(VIOLET)) {
    findings.push({ ok: true, label: 'violet truecolor escape present (popup border/title)' });
  } else {
    findings.push({ ok: false, label: 'violet truecolor escape MISSING in popup' });
  }

  // Type an inline filter — one char at a time.
  for (const ch of '--type merge') {
    pty.write(ch);
    await wait(40);
  }
  await wait(800);
  const filteredPlain = snapshotPlain();
  if (filteredPlain.includes('--type merge')) {
    findings.push({ ok: true, label: 'filter row reflects typed "--type merge"' });
  } else {
    findings.push({
      ok: false,
      label: `filter row did NOT update — screen: ${filteredPlain.slice(0, 600)}`,
    });
  }

  // Esc closes the popup.
  pty.write('\x1b');
  await wait(800);
  const afterEsc = snapshotPlain();
  if (!afterEsc.includes('Audit log')) {
    findings.push({ ok: true, label: 'Esc closed the LogPanel (title gone)' });
  } else {
    findings.push({ ok: false, label: 'Esc did NOT close the LogPanel' });
  }

  // Ctrl+C teardown.
  pty.write('\x03');
  await wait(800);
  const deadline = Date.now() + 6000;
  while (!exited && Date.now() < deadline) await wait(100);
  if (!exited) {
    pty.kill();
    findings.push({ ok: false, label: 'process did NOT exit within 6s after Ctrl+C — forced kill' });
  } else {
    findings.push({ ok: true, label: `process exited cleanly after Ctrl+C (code=${exitCode})` });
  }

  const tail = transcript.slice(-5).join('');
  // eslint-disable-next-line no-control-regex
  const literalBadPattern = /(?<!\x1b)\[<u/;
  if (literalBadPattern.test(tail)) {
    findings.push({ ok: false, label: 'literal "[<u" found in transcript tail — kitty pop misinterpreted' });
  } else {
    findings.push({ ok: true, label: 'no literal kitty pop garbage in transcript tail' });
  }
} catch (err) {
  findings.push({ ok: false, label: `harness error: ${err instanceof Error ? err.message : String(err)}` });
} finally {
  if (!exited) pty.kill();
}

if (process.env['SYMPHONY_PTY_DEBUG'] === '1') {
  console.log('\n=== captured screen ===');
  const buf = term.buffer.active;
  for (let y = 0; y < ROWS; y += 1) {
    const line = buf.getLine(y);
    if (line) console.log(line.translateToString(true));
  }
}

console.log('\n=== Phase 3R PTY smoke results ===');
let allOk = true;
for (const f of findings) {
  const tag = f.ok ? 'PASS' : 'FAIL';
  if (!f.ok) allOk = false;
  console.log(`[${tag}] ${f.label}`);
}
console.log(`\nOverall: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
