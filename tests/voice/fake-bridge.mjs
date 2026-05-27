#!/usr/bin/env node
// Fake Python voice bridge for unit tests.
// Mimics the JSON-line wire protocol of `voice_bridge.py` but is pure
// Node — no Python install, no Silero, no audio. Driven by argv flags.
//
// Usage:
//   node fake-bridge.mjs --scenario <name> [--input-mode <mic|stdin-pcm>]
//
// Scenarios:
//   ready-then-idle: emit ready, await shutdown command, ack, exit 0
//   ready-then-segments: emit ready + 2 (speech_start, speech_end), await shutdown
//   ready-then-crash: emit ready, then exit 2 abnormally
//   no-ready: never emits ready (forces ready-timeout)
//   bad-json: emit a literal non-JSON line, then ready
//   unknown-event: emit a JSON line with type='banana' before ready
//   immediate-exit: exit 1 without ready (spawn-error class)
//
// All scenarios flush each event with a trailing newline.

import process from 'node:process';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function ready() {
  emit({
    type: 'ready',
    backend: 'stdin-pcm',
    sampleRate: 16000,
    vadThreshold: 0.5,
    vadMinSpeechMs: 100,
    vadMinSilenceMs: 400,
  });
}

// Resolve scenario by reading a sidecar `.scenario` file in the same
// dir as this script. VoiceBridge passes argv in a fixed shape and its
// env allowlist is restrictive by design — the sidecar is the cleanest
// out-of-band channel for the test harness. fakePackage helpers in
// bridge.unit.test.ts write the file before each spawn.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
let scenario = 'ready-then-idle';
try {
  scenario = readFileSync(path.join(thisDir, '.scenario'), 'utf8').trim() || scenario;
} catch {
  // No sidecar — argv fallback below.
}
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--scenario') scenario = args[i + 1] ?? scenario;
}

// Always read stdin in a loop so the shutdown command can find us.
process.stdin.setEncoding('utf8');
let stdinBuf = '';
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  let idx = stdinBuf.indexOf('\n');
  while (idx >= 0) {
    const line = stdinBuf.slice(0, idx).trim();
    stdinBuf = stdinBuf.slice(idx + 1);
    if (line.length === 0) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.cmd === 'shutdown') {
        emit({ type: 'shutdown_ack' });
        // Give stdout one tick to flush, then exit clean.
        setTimeout(() => process.exit(0), 5);
      }
    } catch {
      // ignore bad input from test
    }
    idx = stdinBuf.indexOf('\n');
  }
});

// stderr-write probe so stderr-tail tests have something to capture
process.stderr.write('fake-bridge: scenario=' + scenario + '\n');

switch (scenario) {
  case 'ready-then-idle':
    ready();
    break;
  case 'ready-then-segments':
    ready();
    setTimeout(() => emit({ type: 'speech_start', tMs: 500 }), 5);
    setTimeout(() => emit({ type: 'speech_end', tMs: 1500, durationMs: 1000 }), 10);
    setTimeout(() => emit({ type: 'speech_start', tMs: 2000 }), 15);
    setTimeout(() => emit({ type: 'speech_end', tMs: 3000, durationMs: 1000 }), 20);
    break;
  case 'ready-then-crash':
    ready();
    setTimeout(() => process.exit(2), 5);
    break;
  case 'no-ready':
    // Sit forever — bridge.start should time out.
    break;
  case 'bad-json':
    process.stdout.write('this is not json\n');
    ready();
    break;
  case 'unknown-event':
    emit({ type: 'banana', foo: 'bar' });
    ready();
    break;
  case 'immediate-exit':
    process.exit(1);
    break;
  case 'no-ack':
    // Reads shutdown but ignores it — forces the grace timeout path.
    ready();
    process.stdin.removeAllListeners('data');
    break;
  default:
    process.stderr.write('unknown scenario: ' + scenario + '\n');
    process.exit(3);
}
