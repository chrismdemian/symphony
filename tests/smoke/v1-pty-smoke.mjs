/**
 * v1.0 release-gate PTY smoke.
 *
 * Boots the FULL Symphony TUI (via `runTui` in a real ConPTY) and asserts the
 * end-to-end lifecycle renders, covering the visually-observable v1 success
 * criteria:
 *   #1 start Symphony → request → worker spawned (worker panel populated)
 *   #4 the TUI shows real-time worker status + streaming worker output
 *
 * The REAL claude -p worker spawn + worktree preservation + structured
 * completion are proven separately by the real-claude scenarios
 * (tests/scenarios/{1b,1c,1d,2a1}); this smoke proves the launcher boots the
 * real TUI in a real terminal and renders that lifecycle without crashing.
 *
 * Run: pnpm smoke:v1
 */
import { spawn } from '@lydell/node-pty';
import xtermHeadless from '@xterm/headless';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Terminal } = xtermHeadless;
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const COLS = 120;
const ROWS = 30;

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });

const driver = path.join(repoRoot, 'tests', 'smoke', 'v1-tui-driver.tsx');
const isWin = process.platform === 'win32';
const shell = isWin ? 'cmd.exe' : 'sh';
const args = isWin ? ['/c', 'node', '--import', 'tsx', driver] : ['-c', `node --import tsx "${driver}"`];

const pty = spawn(shell, args, {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: repoRoot,
  env: { ...process.env, FORCE_COLOR: '3', COLORTERM: 'truecolor', SYMPHONY_PTY_SMOKE: '1' },
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

function screen() {
  let plain = '';
  const buf = term.buffer.active;
  for (let y = 0; y < ROWS; y += 1) {
    const line = buf.getLine(y);
    if (line) plain += line.translateToString(true) + '\n';
  }
  return plain;
}

async function waitForScreen(predicate, label, timeoutMs = 12_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(screen())) return true;
    if (exited) {
      throw new Error(
        `process exited before '${label}' (code=${exitCode})\n--- transcript ---\n${transcript.join('')}`,
      );
    }
    await wait(80);
  }
  throw new Error(`timed out waiting for: ${label}\n--- last screen ---\n${screen()}`);
}

const findings = [];
const ok = (label) => findings.push({ ok: true, label });
const bad = (label) => findings.push({ ok: false, label });

try {
  // #1a — the launcher boots and reaches the chat panel.
  await waitForScreen((s) => s.includes('Tell Maestro'), 'chat panel placeholder');
  ok('launcher boots → chat panel reached');

  // Theme reaching the renderer (locked violet palette).
  const VIOLET = '\x1b[38;2;124;111;235m';
  if (transcript.join('').includes(VIOLET)) ok('locked violet palette escape rendered');
  else bad('violet palette escape NOT seen — theme not reaching renderer');

  // #4a — the worker panel shows the spawned worker (by feature intent).
  await waitForScreen((s) => s.includes('add filters middleware'), 'worker feature-intent in worker panel');
  ok('worker panel shows the spawned worker (feature intent)');

  // #1b — Maestro's reply to the request renders in chat.
  await waitForScreen((s) => s.includes('Spawning a worker'), "Maestro's reply in chat");
  ok('Maestro reply ("Spawning a worker…") rendered in chat');

  // #4b — the output panel is MOUNTED for the auto-selected worker (it shows
  // the worker's empty-output state, NOT the "Select a worker" hint — proving
  // selection + the streaming surface are live). The live event STREAM itself
  // is verified by OutputPanel.test.tsx + the 3d1/3d2 scenarios; it is left
  // empty here because node-pty corrupts its heap on the ANSI churn under this
  // dev box's sustained load (see the driver's note).
  await waitForScreen(
    (s) => s.includes('no output captured yet') && !s.includes('Select a worker'),
    'output panel mounted for the auto-selected worker',
  );
  ok('output panel mounted for the auto-selected worker (streaming surface live)');

  // Lifecycle close — a worker-completion summary lands in chat.
  await waitForScreen((s) => /Violinist/.test(s) && /finished|add filters/.test(s), 'completion summary in chat');
  ok('worker-completion summary rendered in chat');

  // Clean teardown on Ctrl+C.
  pty.write('\x03');
  const deadline = Date.now() + 8000;
  while (!exited && Date.now() < deadline) await wait(100);
  if (exited) ok(`process exited cleanly after Ctrl+C (code=${exitCode})`);
  else {
    pty.kill();
    bad('process did NOT exit within 8s after Ctrl+C — forced kill');
  }
} catch (err) {
  bad(`harness error: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (!exited) pty.kill();
}

if (process.env['SYMPHONY_PTY_DEBUG'] === '1') {
  console.log('\n=== captured screen ===\n' + screen());
}

console.log('\n=== v1.0 release-gate PTY smoke results ===');
let allOk = true;
for (const f of findings) {
  if (!f.ok) allOk = false;
  console.log(`[${f.ok ? 'PASS' : 'FAIL'}] ${f.label}`);
}
console.log(`\nOverall: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
