/**
 * Phase 7C PTY smoke test.
 *
 * Boots the 7C driver inside a real ConPTY, opens the plugins popup via
 * `/plugins`, toggles a plugin row, opens + cancels the install input, and
 * asserts:
 *   1. App launches without crash (status bar visible).
 *   2. `/plugins` + Enter opens the PluginsPanel ("Plugins" title + "master
 *      switch" + a plugin name + the ✓ enabled / ○ disabled glyphs).
 *   3. Truecolor escapes present (violet border/title).
 *   4. ↓ then Space toggles the disabled "Echo" row → it flips to ✓ enabled.
 *   5. "i" opens the install input ("Install source:"); Esc cancels it.
 *   6. Esc closes the popup (back to chat).
 *   7. Ctrl+C teardown completes cleanly (no kitty pop garbage).
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

const driver = path.join(repoRoot, 'tests', 'smoke', '7c-tui-driver.tsx');
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
    findings.push({ ok: false, label: `status bar NOT visible — first 600 chars: ${bootPlain.slice(0, 600)}` });
  }

  // Open the plugins popup: "/plugins" then Enter (separate writes — ink
  // treats multi-char chunks as paste).
  pty.write('/plugins');
  await wait(150);
  pty.write('\r');
  await wait(1200);

  const panelPlain = snapshotPlain();
  if (panelPlain.includes('Plugins') && panelPlain.includes('master switch')) {
    findings.push({ ok: true, label: 'PluginsPanel opened ("Plugins" + "master switch" visible)' });
  } else {
    findings.push({ ok: false, label: `PluginsPanel did NOT open — screen: ${panelPlain.slice(0, 700)}` });
  }

  if (panelPlain.includes('Notifier') && panelPlain.includes('Echo')) {
    findings.push({ ok: true, label: 'plugin rows visible (Notifier + Echo)' });
  } else {
    findings.push({ ok: false, label: `plugin rows NOT visible — screen: ${panelPlain.slice(0, 700)}` });
  }

  if (panelPlain.includes('enabled') && panelPlain.includes('disabled')) {
    findings.push({ ok: true, label: 'enabled/disabled state glyphs visible' });
  } else {
    findings.push({ ok: false, label: 'state glyphs NOT visible' });
  }

  const serialized = serializeAddon.serialize();
  if (serialized.includes(VIOLET)) {
    findings.push({ ok: true, label: 'violet truecolor escape present (popup border/title)' });
  } else {
    findings.push({ ok: false, label: 'violet truecolor escape MISSING in popup' });
  }

  // ↓ to the first plugin row (Notifier, index 1) is enabled; go one more to
  // Echo (disabled) then Space to enable it.
  pty.write('\x1b[B'); // → Notifier
  await wait(120);
  pty.write('\x1b[B'); // → Echo
  await wait(120);
  pty.write(' '); // toggle Echo → enabled
  await wait(900);
  const afterToggle = snapshotPlain();
  // Echo's row should now read "✓ enabled"; before there was exactly one
  // enabled (Notifier). Count enabled occurrences as a coarse check.
  const enabledCount = (afterToggle.match(/✓ enabled/g) ?? []).length;
  if (enabledCount >= 2) {
    findings.push({ ok: true, label: `toggle flipped Echo to enabled (${enabledCount} enabled rows)` });
  } else {
    findings.push({ ok: false, label: `toggle did NOT flip Echo — enabled rows=${enabledCount}; screen: ${afterToggle.slice(0, 700)}` });
  }

  // "i" opens the install input.
  pty.write('i');
  await wait(500);
  const installPlain = snapshotPlain();
  if (installPlain.includes('Install source:')) {
    findings.push({ ok: true, label: 'install input opened ("Install source:" visible)' });
  } else {
    findings.push({ ok: false, label: `install input did NOT open — screen: ${installPlain.slice(0, 700)}` });
  }
  // Esc cancels the install input (back to the list, not closing the popup).
  pty.write('\x1b');
  await wait(600);
  const afterCancel = snapshotPlain();
  if (!afterCancel.includes('Install source:') && afterCancel.includes('master switch')) {
    findings.push({ ok: true, label: 'Esc cancelled the install input (back to the list)' });
  } else {
    findings.push({ ok: false, label: 'Esc did NOT cancel the install input cleanly' });
  }

  // Esc closes the popup.
  pty.write('\x1b');
  await wait(700);
  const afterEsc = snapshotPlain();
  if (!afterEsc.includes('master switch')) {
    findings.push({ ok: true, label: 'Esc closed the PluginsPanel (back to chat)' });
  } else {
    findings.push({ ok: false, label: 'Esc did NOT close the PluginsPanel' });
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

console.log('\n=== Phase 7C PTY smoke results ===');
let allOk = true;
for (const f of findings) {
  const tag = f.ok ? 'PASS' : 'FAIL';
  if (!f.ok) allOk = false;
  console.log(`[${tag}] ${f.label}`);
}
console.log(`\nOverall: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
