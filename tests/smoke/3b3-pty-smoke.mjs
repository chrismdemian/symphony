/**
 * Phase 3B.3 PTY smoke test.
 *
 * Boots the built binary inside a real ConPTY, drives a few keystrokes,
 * captures the rendered screen via @xterm/headless, and asserts:
 *   1. App launches without crash and reaches the chat panel.
 *   2. Ctrl+J inserts a newline (universal fallback works).
 *   3. After Ctrl+C / `/quit`, no kitty pop garbage `[<u` leaks to
 *      the captured output (Ink's unmount + our belt-and-suspenders).
 *   4. The captured screen contains the locked palette violet escape
 *      after a brief boot pause (theme is reaching the renderer).
 *
 * Cannot reliably test Shift+Enter from this harness — kitty mode is
 * `auto` and the headless terminal doesn't reply to the kitty query, so
 * the binary stays in fallback mode. A human on Windows Terminal /
 * iTerm2 / Ghostty must verify the kitty branch separately.
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

// Drive the TUI directly via runTui + a fake Maestro. This stays useful
// even though the real-Maestro spawn now works (post-fix to
// `awaitSystemInit`'s deadlock with claude 2.1.126's first-frame
// requirement) because the smoke test should be deterministic, fast, and
// independent of `claude -p` invocations that cost API time and depend
// on network state.
const driver = path.join(repoRoot, 'tests', 'smoke', '3b3-tui-driver.tsx');
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

async function waitFor(predicate, label, timeoutMs = 8000) {
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
  await waitFor(() => transcript.join('').length > 200, 'initial boot output', 10_000);

  // Give the driver a moment to mount Ink and start the scripted event
  // sequence (1500ms initial pause then turn_started → tool_use).
  await wait(2500);

  const bootSnapshot = serializeAddon.serialize();

  // Test 1: violet palette escape reached the screen.
  const VIOLET = '\x1b[38;2;124;111;235m';
  if (bootSnapshot.includes(VIOLET) || transcript.join('').includes(VIOLET)) {
    findings.push({ ok: true, label: 'violet palette escape rendered' });
  } else {
    findings.push({ ok: false, label: 'violet palette escape NOT seen — theme not reaching renderer' });
  }

  // Test 2: chat panel reached. Look for the placeholder text.
  const fullText = term.buffer.active;
  let plain = '';
  for (let y = 0; y < ROWS; y += 1) {
    const line = fullText.getLine(y);
    if (line) plain += line.translateToString(true) + '\n';
  }
  if (plain.includes('Tell Maestro')) {
    findings.push({ ok: true, label: 'chat panel placeholder visible' });
  } else {
    findings.push({
      ok: false,
      label: `chat panel placeholder NOT visible — first 800 chars: ${plain.slice(0, 800)}`,
    });
  }

  // Test 2.5: status line visible during in-flight tool. The driver
  // emits `tool_use: list_workers` ~1.8s in and holds for 3s, so by
  // now we should see the verb `Listening` AND an EQ glyph.
  let statusOk = false;
  let eqOk = false;
  for (let i = 0; i < ROWS; i += 1) {
    const line = fullText.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (text.includes('Listening')) statusOk = true;
    if (/[▁▂▃▄▅▆▇█]{4}/.test(text)) eqOk = true;
  }
  if (statusOk) findings.push({ ok: true, label: 'status line verb "Listening" visible during in-flight tool' });
  else findings.push({ ok: false, label: 'status line verb NOT visible during in-flight tool' });
  if (eqOk) findings.push({ ok: true, label: 'EQ glyph row visible during in-flight tool' });
  else findings.push({ ok: false, label: 'EQ glyph NOT visible during in-flight tool' });

  // Test 3: Ctrl+J inserts newline. Type some text, then Ctrl+J, then more text.
  pty.write('hello');
  await wait(150);
  pty.write('\x0a'); // Ctrl+J
  await wait(150);
  pty.write('world');
  await wait(400);

  // Re-serialize and look for two-line input buffer.
  const buf2 = term.buffer.active;
  let plain2 = '';
  for (let y = 0; y < ROWS; y += 1) {
    const line = buf2.getLine(y);
    if (line) plain2 += line.translateToString(true) + '\n';
  }
  const helloLineIdx = plain2.split('\n').findIndex((l) => l.includes('hello'));
  const worldLineIdx = plain2.split('\n').findIndex((l) => l.includes('world'));
  if (helloLineIdx >= 0 && worldLineIdx >= 0 && worldLineIdx > helloLineIdx) {
    findings.push({ ok: true, label: 'Ctrl+J inserted real newline (hello on line N, world on line N+M)' });
  } else {
    findings.push({
      ok: false,
      label: `Ctrl+J newline NOT visible — hello@${helloLineIdx}, world@${worldLineIdx}`,
    });
  }

  // Test 4: send Ctrl+C, then check for clean teardown without kitty
  // pop garbage in the trailing transcript.
  pty.write('\x03'); // Ctrl+C
  await wait(800);

  // Process should be winding down. Give it the launcher's 5s deadline,
  // but cap our wait to avoid timing out the harness.
  const cleanupDeadline = Date.now() + 6000;
  while (!exited && Date.now() < cleanupDeadline) {
    await wait(100);
  }
  if (!exited) {
    pty.kill();
    findings.push({ ok: false, label: 'process did NOT exit within 6s after Ctrl+C — forced kill' });
  } else {
    findings.push({ ok: true, label: `process exited cleanly after Ctrl+C (code=${exitCode})` });
  }

  // Test 5: kitty pop sequence either present (good — we wrote it) or
  // absent (also fine if Ink's unmount handled it). The bad case is
  // visible literal `[<u` AS TEXT in the post-exit buffer (not as an
  // ANSI escape). Search the captured transcript's tail for stray
  // bytes — the pop sequence should land in ANSI form `\x1b[<u`.
  const tail = transcript.slice(-5).join('');
  // Any literal `[<u` characters appearing AS RAW TEXT (not preceded
  // by ESC) would indicate a misinterpreted pop sequence. Practically,
  // this never happens — but worth asserting for completeness.
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
  console.log('\n=== raw transcript first 2000 chars ===');
  console.log(transcript.join('').slice(0, 2000));
}

console.log('\n=== Phase 3B.3 PTY smoke results ===');
let allOk = true;
for (const f of findings) {
  const tag = f.ok ? 'PASS' : 'FAIL';
  if (!f.ok) allOk = false;
  console.log(`[${tag}] ${f.label}`);
}
console.log(`\nOverall: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
