#!/usr/bin/env node
// Scripted stand-in for `claude -p --output-format stream-json` with full
// NDJSON-over-stdin support. Reads a scenario manifest and steps through it
// interactively: replays assistant turns, pauses for user stdin messages,
// emits control_request events and waits for control_response acks.
//
// Usage:
//   node tests/helpers/fake-claude-interactive.mjs <scenario-name>
//
// Scenarios live in tests/helpers/fake-scenarios/<name>.json and look like:
//   {
//     "steps": [
//       { "action": "emit", "line": {...} },
//       { "action": "await_user", "matchContainsText": "second prompt" },
//       { "action": "control_request",
//         "requestId": "req-1", "toolName": "Bash",
//         "input": {"command": "ls"} },
//       { "action": "sleep", "ms": 50 },
//       { "action": "exit", "code": 0 }
//     ]
//   }

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import readline from 'node:readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(__dirname, 'fake-scenarios');

const args = process.argv.slice(2);
const scenarioName = args[0];
if (!scenarioName) {
  process.stderr.write('fake-claude-interactive: scenario name required\n');
  process.exit(2);
}

const path = join(scenariosDir, `${scenarioName}.json`);
let scenario;
try {
  scenario = JSON.parse(readFileSync(path, 'utf8'));
} catch (err) {
  process.stderr.write(
    `fake-claude-interactive: failed to load ${path}: ${err.message}\n`,
  );
  process.exit(2);
}

const pendingStdin = [];
const stdinWaiters = [];
let stdinClosed = false;

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = { type: 'invalid', raw: trimmed };
  }
  if (stdinWaiters.length > 0) {
    const waiter = stdinWaiters.shift();
    waiter(parsed);
  } else {
    pendingStdin.push(parsed);
  }
});
rl.on('close', () => {
  stdinClosed = true;
  while (stdinWaiters.length > 0) {
    const waiter = stdinWaiters.shift();
    waiter(null);
  }
});

function nextStdin() {
  if (pendingStdin.length > 0) return Promise.resolve(pendingStdin.shift());
  if (stdinClosed) return Promise.resolve(null);
  return new Promise((resolve) => stdinWaiters.push(resolve));
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function run() {
  for (const step of scenario.steps) {
    switch (step.action) {
      case 'emit':
        emit(step.line);
        break;
      case 'sleep':
        await wait(step.ms ?? 0);
        break;
      case 'await_user': {
        let gotMessage = false;
        while (true) {
          const message = await nextStdin();
          if (message === null) break;
          if (message?.type !== 'user') continue;
          const content = message.message?.content?.[0]?.text ?? '';
          if (
            step.matchContainsText === undefined ||
            content.includes(step.matchContainsText)
          ) {
            gotMessage = true;
            break;
          }
        }
        if (!gotMessage && step.required === true) {
          process.stderr.write(
            `fake-claude-interactive: expected user message containing "${step.matchContainsText}" but stdin closed\n`,
          );
          process.exit(3);
        }
        break;
      }
      case 'control_request': {
        emit({
          type: 'control_request',
          request_id: step.requestId,
          request: {
            subtype: 'can_use_tool',
            tool_name: step.toolName,
            input: step.input ?? {},
          },
        });
        // Wait for the matching control_response
        const deadline = Date.now() + (step.timeoutMs ?? 5_000);
        while (Date.now() < deadline) {
          const msg = await nextStdin();
          if (msg === null) break;
          if (
            msg?.type === 'control_response' &&
            msg?.response?.request_id === step.requestId
          ) {
            break;
          }
        }
        break;
      }
      case 'exit':
        process.exit(step.code ?? 0);
        break;
      default:
        process.stderr.write(`fake-claude-interactive: unknown action ${step.action}\n`);
        process.exit(4);
    }
  }
  process.exit(0);
}

run().catch((err) => {
  process.stderr.write(`fake-claude-interactive: ${err.stack ?? err.message}\n`);
  process.exit(5);
});
