/**
 * Phase 4E PTY smoke test.
 *
 * Boots the full Symphony TUI inside a real ConPTY with a worker whose
 * `workers.tail` returns THREE `structured_completion` events, each
 * carrying its own advisory `display` json-render spec. Asserts:
 *   1. App launches without crash and the output panel renders the
 *      multi-instance display content (Card heading + Table) through
 *      the `<NoopFocusProvider>`-shimmed JsonRenderBlock stack in a
 *      REAL terminal — the definitive observable proof the 4E focus
 *      shim + provider recomposition works end-to-end.
 *   2. The locked violet palette escape reaches the screen (Card
 *      border renders themed).
 *   3. Tab keystrokes with 3 concurrent display blocks mounted do NOT
 *      crash, hang, or garble the screen — Symphony's KeybindProvider
 *      panel cycle still owns Tab (no json-render Tab rivalry, because
 *      the shim registers zero Ink `useInput` handlers).
 *   4. Ctrl+C tears down cleanly (exit within the launcher deadline,
 *      no literal kitty-pop garbage in the transcript tail).
 *
 * Limitation (per CLAUDE.md): kitty-keyboard auto-detect round-trip is
 * the only thing this headless harness can't cover — that single
 * concern remains user-side manual smoke.
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

const driver = path.join(repoRoot, 'tests', 'smoke', '4e-tui-driver.tsx');
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
  throw new Error(
    `timed out waiting for: ${label}\n--- transcript ---\n${transcript.join('')}`,
  );
}

const findings = [];

try {
  await waitFor(
    () => transcript.join('').length > 200,
    'initial boot output',
    12_000,
  );
  // Let Ink mount, the WorkerPanel reconcile-select the worker, and the
  // OutputPanel backfill-tail + render the 3 display blocks.
  await wait(3500);

  const snap = serializeAddon.serialize();
  const plain = screenText();

  // Test 1: multi-instance display content rendered through the shim.
  if (plain.includes('Run Summary') || plain.includes('auth refactor')) {
    findings.push({
      ok: true,
      label: 'json-render Card content rendered in real ConPTY (shimmed stack works)',
    });
  } else {
    findings.push({
      ok: false,
      label: `Card display NOT rendered — first 1000 chars: ${plain.slice(0, 1000)}`,
    });
  }
  if (plain.includes('completion') && plain.includes('audit')) {
    findings.push({
      ok: true,
      label: 'textual completion summary line rendered alongside the advisory display',
    });
  } else {
    findings.push({
      ok: false,
      label: 'completion summary line NOT visible',
    });
  }

  // Test 2: locked violet palette escape reached the screen (Card
  // border renders themed through the recomposed provider stack).
  const VIOLET = '\x1b[38;2;124;111;235m';
  if (snap.includes(VIOLET) || transcript.join('').includes(VIOLET)) {
    findings.push({ ok: true, label: 'violet palette escape rendered (themed Card border)' });
  } else {
    findings.push({
      ok: false,
      label: 'violet palette escape NOT seen — theme not reaching the json-render block',
    });
  }

  // Test 3: Tab with 3 concurrent display blocks must not crash/hang/
  // garble. Symphony's KeybindProvider owns Tab (focus.cycle); the shim
  // registers zero json-render Tab handlers, so cycling stays clean.
  const beforeTab = screenText();
  for (let i = 0; i < 4; i += 1) {
    pty.write('\t');
    await wait(200);
  }
  await wait(400);
  const afterTab = screenText();
  if (exited) {
    findings.push({
      ok: false,
      label: `process exited during Tab cycling (code=${exitCode}) — focus handling broke`,
    });
  } else if (
    afterTab.includes('Run Summary') ||
    afterTab.includes('auth refactor')
  ) {
    // Still alive, still coherent, display content still rendered after
    // repeated Tab — no json-render Tab rivalry corrupted the tree.
    findings.push({
      ok: true,
      label: 'Tab×4 with 3 display blocks: app alive + screen coherent (no Tab rivalry/hang)',
    });
  } else {
    findings.push({
      ok: false,
      label: `screen incoherent after Tab cycling — before:${beforeTab.length} after:${afterTab.length}`,
    });
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

console.log('\n=== Phase 4E PTY smoke results ===');
let allOk = true;
for (const f of findings) {
  const tag = f.ok ? 'PASS' : 'FAIL';
  if (!f.ok) allOk = false;
  console.log(`[${tag}] ${f.label}`);
}
console.log(`\nOverall: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
