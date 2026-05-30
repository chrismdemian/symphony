#!/usr/bin/env node
// Fake T5 summarizer subprocess for Phase 6D.2 LocalSummarizer unit tests.
// Mimics the JSON-line wire protocol of `summarizer.py` but is pure Node —
// no Python, no onnxruntime, no model. Driven by a `.scenario` sidecar in
// the script's own dir (the LocalSummarizer env allowlist is restrictive,
// so a sidecar is the cleanest out-of-band channel — same pattern as
// fake-bridge.mjs).
//
// Scenarios:
//   ready-echo         : emit ready; on summarize -> {summary, text:"LLM:<joined>"}
//   fatal-load         : emit {error, fatal:true} then exit 1 (model missing)
//   per-request-error  : emit ready; on summarize -> {error, id} (non-fatal)
//   no-ready           : never emit ready (forces ready timeout)
//   summarize-hang     : emit ready; ignore summarize (forces summarize timeout)
//   crash-after-ready  : emit ready; exit 1 on first summarize
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
let scenario = 'ready-echo';
try {
  scenario = readFileSync(path.join(thisDir, '.summarizer-scenario'), 'utf8').trim() || scenario;
} catch {
  // argv fallback
}
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--scenario') scenario = args[i + 1] ?? scenario;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

if (scenario === 'fatal-load') {
  emit({ type: 'error', fatal: true, message: 'model files missing' });
  process.exit(1);
}
if (scenario === 'no-ready') {
  // Sit forever; LocalSummarizer.start should time out.
  process.stdin.resume();
} else {
  emit({ type: 'ready' });
}

let firstSummarize = true;
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx = buf.indexOf('\n');
  while (idx >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    idx = buf.indexOf('\n');
    if (line.length === 0) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.cmd === 'shutdown') {
      emit({ type: 'shutdown_ack' });
      setTimeout(() => process.exit(0), 5);
      continue;
    }
    if (msg.cmd === 'summarize') {
      if (scenario === 'summarize-hang') continue; // never respond
      if (scenario === 'crash-after-ready' && firstSummarize) {
        firstSummarize = false;
        process.exit(1);
      }
      if (scenario === 'per-request-error') {
        emit({ type: 'error', id: msg.id, message: 'inference failed' });
        continue;
      }
      // ready-echo (default): prefix the joined texts so tests can tell the
      // LLM path ran vs the heuristic fallback.
      const joined = Array.isArray(msg.texts) ? msg.texts.join('|') : '';
      emit({ type: 'summary', id: msg.id, text: `LLM:${joined}` });
    }
  }
});
