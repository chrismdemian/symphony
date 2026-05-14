/**
 * Phase 3S PTY smoke test.
 *
 * Boots the 3S driver inside a real ConPTY, drives three Ctrl+Y
 * keystrokes, and asserts:
 *   1. App launches without crash and the status bar is visible.
 *   2. Initial render shows the Tier-2 chip (violet, "T2 Notify").
 *   3. Ctrl+Y flips the chip to Tier 3 (amber, "T3 Confirm").
 *   4. Another Ctrl+Y flips to Tier 1 (gold, "T1 Free").
 *   5. Ctrl+C teardown completes cleanly (no kitty pop garbage).
 *
 * Cannot test workers.sendTo (Mission Control inject) from this harness
 * because the fake RPC has no live workers — `i` is a panel-scoped
 * command that requires a selected worker. Unit tests + the production
 * scenario cover that path.
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

const driver = path.join(repoRoot, 'tests', 'smoke', '3s-tui-driver.tsx');
const isWin = process.platform === 'win32';
const shell = isWin ? 'cmd.exe' : 'sh';
const args = isWin
  ? ['/c', 'node', '--import', 'tsx', driver]
  : ['-c', `node --import tsx "${driver}"`];

// Phase 3S — sandbox the config file so the smoke doesn't read/write
// the user's real ~/.symphony/config.json. Each smoke run starts from
// schema defaults (autonomyTier=2) regardless of what the user has set.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const sandboxConfigDir = mkdtempSync(path.join(tmpdir(), 'symphony-3s-smoke-'));
const sandboxConfigFile = path.join(sandboxConfigDir, 'config.json');

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
    SYMPHONY_CONFIG_FILE: sandboxConfigFile,
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
const GOLD = '\x1b[38;2;212;168;67m';
const AMBER = '\x1b[38;2;229;192;123m';

try {
  // Wait for boot. Generous because the driver loads ConfigProvider +
  // initial useEffect chain before rendering the bar.
  await wait(4000);

  // Test 1: status bar visible.
  const bootPlain = snapshotPlain();
  if (bootPlain.includes('Mode:')) {
    findings.push({ ok: true, label: 'status bar rendered (Mode: segment visible)' });
  } else {
    findings.push({
      ok: false,
      label: `status bar NOT visible — first 600 chars: ${bootPlain.slice(0, 600)}`,
    });
  }

  // Test 2: initial Tier 2 chip (violet).
  if (bootPlain.includes('T2 Notify')) {
    findings.push({ ok: true, label: 'initial Tier 2 chip "T2 Notify" visible' });
  } else {
    findings.push({
      ok: false,
      label: `initial Tier 2 chip NOT visible — bar slice: ${bootPlain.slice(0, 400)}`,
    });
  }

  const bootSerialized = serializeAddon.serialize();
  if (bootSerialized.includes(VIOLET)) {
    findings.push({ ok: true, label: 'violet truecolor escape present at boot (T2 chip color)' });
  } else {
    findings.push({ ok: false, label: 'violet truecolor escape MISSING at boot' });
  }

  // Test 3: Ctrl+Y → Tier 3 (amber).
  pty.write('\x19');
  await wait(600);
  const tier3Plain = snapshotPlain();
  if (tier3Plain.includes('T3 Confirm')) {
    findings.push({ ok: true, label: 'after Ctrl+Y: Tier 3 chip "T3 Confirm" visible' });
  } else {
    findings.push({
      ok: false,
      label: `Tier 3 chip NOT visible — slice: ${tier3Plain.slice(0, 400)}`,
    });
  }
  const tier3Serialized = serializeAddon.serialize();
  if (tier3Serialized.includes(AMBER)) {
    findings.push({ ok: true, label: 'amber truecolor escape present after Ctrl+Y (T3 chip color)' });
  } else {
    findings.push({ ok: false, label: 'amber truecolor escape MISSING after Ctrl+Y' });
  }

  // Test 4: Ctrl+Y → Tier 1 (gold).
  pty.write('\x19');
  await wait(600);
  const tier1Plain = snapshotPlain();
  if (tier1Plain.includes('T1 Free')) {
    findings.push({ ok: true, label: 'after 2nd Ctrl+Y: Tier 1 chip "T1 Free" visible' });
  } else {
    findings.push({
      ok: false,
      label: `Tier 1 chip NOT visible — slice: ${tier1Plain.slice(0, 400)}`,
    });
  }
  const tier1Serialized = serializeAddon.serialize();
  if (tier1Serialized.includes(GOLD)) {
    findings.push({ ok: true, label: 'gold truecolor escape present after 2nd Ctrl+Y (T1 chip color)' });
  } else {
    findings.push({ ok: false, label: 'gold truecolor escape MISSING after 2nd Ctrl+Y' });
  }

  // Test 5: Ctrl+C teardown.
  pty.write('\x03');
  await wait(800);
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

  // Test 6: no kitty pop garbage in transcript tail.
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
  // Audit Minor #5 — clean up the sandbox config dir. mkdtempSync would
  // otherwise leak `symphony-3s-smoke-*` directories on CI workers that
  // retain disk state across runs.
  try {
    rmSync(sandboxConfigDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
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

console.log('\n=== Phase 3S PTY smoke results ===');
let allOk = true;
for (const f of findings) {
  const tag = f.ok ? 'PASS' : 'FAIL';
  if (!f.ok) allOk = false;
  console.log(`[${tag}] ${f.label}`);
}
console.log(`\nOverall: ${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
