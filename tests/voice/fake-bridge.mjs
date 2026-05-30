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
//   no-ack: ignores shutdown, forces grace timeout
//   stt-happy: ready + stt_ready + (on stdin EOF) speech_start + partial + speech_end + final
//   stt-ready-never: ready but no stt_ready (forces stt-ready timeout)
//   stt-no-final: ready + stt_ready + speech_start + speech_end + (no final)
//   stt-truncated: ready + stt_ready + (on stdin EOF) warning + speech_end + final
//   wake-fire: ready + (after 10ms) wake_word — Phase 6C
//   wake-malformed: ready + a wake_word event missing the `score` field (validator rejection test)
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
// In stt-* scenarios we treat stdin as raw PCM (drained but ignored),
// firing the segment events on stdin EOF.
const isSttScenario =
  typeof scenario === 'string' && scenario.startsWith('stt-');
let stdinClosedFired = false;
const onStdinClose = () => {
  if (stdinClosedFired) return;
  stdinClosedFired = true;
  switch (scenario) {
    case 'stt-happy': {
      emit({ type: 'speech_start', tMs: 500 });
      emit({ type: 'partial', seq: 1, text: 'hello', tMs: 700 });
      emit({ type: 'speech_end', tMs: 1500, durationMs: 1000 });
      emit({ type: 'final', seq: 2, text: 'hello world', tMs: 1500, durationMs: 1000 });
      emit({ type: 'shutdown_ack' });
      setTimeout(() => process.exit(0), 5);
      break;
    }
    case 'stt-no-final': {
      emit({ type: 'speech_start', tMs: 500 });
      emit({ type: 'speech_end', tMs: 1500, durationMs: 1000 });
      emit({ type: 'shutdown_ack' });
      setTimeout(() => process.exit(0), 5);
      break;
    }
    case 'stt-truncated': {
      emit({ type: 'speech_start', tMs: 100 });
      emit({ type: 'partial', seq: 1, text: 'thirty seconds of', tMs: 5000 });
      emit({ type: 'warning', code: 'utterance-truncated', tMs: 30000 });
      emit({ type: 'speech_end', tMs: 30000, durationMs: 29900 });
      emit({
        type: 'final',
        seq: 2,
        text: 'thirty seconds of speech',
        tMs: 30000,
        durationMs: 29900,
      });
      emit({ type: 'shutdown_ack' });
      setTimeout(() => process.exit(0), 5);
      break;
    }
    default:
      break;
  }
};

if (isSttScenario) {
  // Drain stdin in raw mode (we don't parse it as JSON). On 'end',
  // emit the scripted STT events.
  process.stdin.on('data', () => {
    /* discard raw PCM */
  });
  process.stdin.on('end', onStdinClose);
} else {
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
}

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
  case 'stt-happy':
    ready();
    setTimeout(() => emit({ type: 'stt_ready', model: 'moonshine/base' }), 5);
    break;
  case 'stt-no-final':
    ready();
    setTimeout(() => emit({ type: 'stt_ready', model: 'moonshine/base' }), 5);
    break;
  case 'stt-truncated':
    ready();
    setTimeout(() => emit({ type: 'stt_ready', model: 'moonshine/base' }), 5);
    break;
  case 'stt-ready-never':
    // Ready fires but stt_ready never does — forces the stt-ready-timeout
    // path in runVoiceTranscribe.
    ready();
    break;
  case 'wake-fire':
    // Phase 6C — emit ready, then a wake_word event after 10 ms.
    ready();
    setTimeout(
      () =>
        emit({
          type: 'wake_word',
          model: 'hey-symphony',
          score: 0.87,
          tMs: 1234,
        }),
      10,
    );
    break;
  case 'wake-malformed':
    // Phase 6C — wake_word event missing the `score` field. Bridge's
    // isVoiceBridgeEvent validator must reject this, emitting a
    // `malformed-event` error event instead of crashing.
    ready();
    setTimeout(
      () => emit({ type: 'wake_word', model: 'hey-symphony', tMs: 9999 }),
      10,
    );
    break;
  case 'wake-disabled-warning':
    // Phase 6C (audit-M2) — emit ready, then a `warning` with the new
    // `wake-word-disabled` code (the Python bridge sends this when a
    // set_wake_threshold command arrives while wake-word is off). The
    // validator must ACCEPT this code (not downgrade to malformed-event).
    ready();
    setTimeout(
      () => emit({ type: 'warning', code: 'wake-word-disabled', tMs: 4242 }),
      10,
    );
    break;
  default:
    process.stderr.write('unknown scenario: ' + scenario + '\n');
    process.exit(3);
}
