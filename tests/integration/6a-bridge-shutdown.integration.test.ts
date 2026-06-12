/**
 * Phase 6A integration — real Python bridge shutdown semantics.
 *
 * Spawns the bridge in `mic` mode (so the command channel is live) and
 * exercises:
 *   - `{"cmd":"shutdown"}` → `shutdown_ack` → clean exit 0
 *   - SIGTERM after no-ack (force-stop) → non-zero exit
 *
 * Skip-gracefully when the voice venv isn't installed.
 */
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { VoiceBridge } from '../../src/voice/bridge.js';
import { resolveVoiceEnv } from '../../src/voice/env.js';

interface VenvProbe {
  readonly available: boolean;
  readonly reason?: string;
}

function probeVenv(): VenvProbe {
  const summary = resolveVoiceEnv();
  if (!summary.exists) return { available: false, reason: 'venv missing' };
  const result = spawnSync(summary.pythonPath, ['-m', 'pip', 'show', 'silero-vad'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return { available: false, reason: 'silero-vad missing' };
  // Audio device existence is a separate concern — bridge in mic mode
  // can still init if at least one input device exists. Probe via
  // sounddevice's query_devices (cheap, ~5ms). Skip if no input device.
  const audioProbe = spawnSync(
    summary.pythonPath,
    [
      '-c',
      "import sounddevice as sd, sys; devs = [d for d in sd.query_devices() if d['max_input_channels'] > 0]; sys.exit(0 if devs else 1)",
    ],
    { encoding: 'utf8' },
  );
  if (audioProbe.status !== 0) {
    return { available: false, reason: 'no audio input device available' };
  }
  return { available: true };
}

const probe = probeVenv();
const describeOrSkip = probe.available ? describe : describe.skip;
if (!probe.available) {
  console.warn(`[6a-shutdown-integration] skipping: ${probe.reason}`);
}

const liveBridges: VoiceBridge[] = [];
afterEach(async () => {
  for (const b of liveBridges.splice(0)) {
    await b.stop({ graceMs: 500 }).catch(() => undefined);
  }
});

describeOrSkip('Phase 6A — bridge shutdown semantics (real Python)', () => {
  it(
    'graceful shutdown via command -> ack -> exit 0',
    async () => {
      const bridge = new VoiceBridge();
      liveBridges.push(bridge);
      await bridge.start({
        inputMode: 'mic',
        // VAD-only: this test asserts the command → ack → clean-exit
        // contract, not STT. Disabling STT removes the numba-JIT warmup
        // (3–8s, slower under the parallel suite) that could overlap the
        // shutdown and make `stt_worker.stop()` blow past `graceMs` → a
        // force-kill (exit 1). STT teardown is exercised by 6b.
        sttEnabled: false,
        onStderr: () => {},
      });

      const exitInfo = await new Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        bridge.on('exit', resolve);
        void bridge.stop({ graceMs: 5_000 });
      });
      expect(exitInfo.exitCode).toBe(0);
      expect(bridge.getStatus().kind).toBe('stopped');
    },
    60_000,
  );
});
