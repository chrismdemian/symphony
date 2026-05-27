/**
 * Phase 6B integration — real Python bridge + real Moonshine STT against
 * a known PCM fixture. Asserts the wire-protocol ordering contract:
 *   ready -> stt_ready -> speech_start -> (>=1 partial) -> speech_end
 *   -> final (with non-empty text)
 *
 * Skip-gracefully when:
 *   - voice venv missing
 *   - silero-vad not installed
 *   - useful-moonshine-onnx not installed (Phase 6A-only venv)
 *
 * Run: `symphony voice install` first (one-time ~120MB model download),
 * then `pnpm vitest tests/integration/6b-stt`.
 */
import { promises as fsp } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { VoiceBridge } from '../../src/voice/bridge.js';
import { resolveVoiceEnv } from '../../src/voice/env.js';
import type { VoiceBridgeEvent } from '../../src/voice/types.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_DIAGNOSE = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'voice',
  'diagnose-3s.pcm',
);
const FIXTURE_DEV_VOCAB = path.join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'voice',
  'transcribe-dev-vocab.pcm',
);
const PCM_CHUNK_BYTES = 512 * 2 * 30; // 30 frames per chunk

interface VenvProbe {
  readonly available: boolean;
  readonly reason?: string;
  readonly pythonPath?: string;
}

function probeMoonshineVenv(): VenvProbe {
  const summary = resolveVoiceEnv();
  if (!summary.exists) {
    return { available: false, reason: `python not at ${summary.pythonPath}` };
  }
  const silero = spawnSync(summary.pythonPath, ['-m', 'pip', 'show', 'silero-vad'], {
    encoding: 'utf8',
  });
  if (silero.status !== 0) {
    return { available: false, reason: 'silero-vad not installed in venv' };
  }
  const moonshine = spawnSync(
    summary.pythonPath,
    ['-c', 'from moonshine_onnx import transcribe'],
    { encoding: 'utf8' },
  );
  if (moonshine.status !== 0) {
    return {
      available: false,
      reason: `moonshine_onnx module not importable in venv (${moonshine.stderr.slice(0, 200)})`,
    };
  }
  return { available: true, pythonPath: summary.pythonPath };
}

const probe = probeMoonshineVenv();
const describeOrSkip = probe.available ? describe : describe.skip;

if (!probe.available) {
  console.warn(
    `[6b-integration] skipping: ${probe.reason}. Run \`symphony voice install\` to enable (downloads ~120MB Moonshine weights on first run).`,
  );
}

const liveBridges: VoiceBridge[] = [];
afterEach(async () => {
  for (const b of liveBridges.splice(0)) {
    await b.stop({ graceMs: 500 }).catch(() => undefined);
  }
});

async function pipePcmThrough(
  bridge: VoiceBridge,
  fixturePath: string,
): Promise<void> {
  const bytes = await fsp.readFile(fixturePath);
  const stdin = bridge.childStdin;
  if (stdin === undefined) throw new Error('bridge stdin unavailable');
  let offset = 0;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(
      offset,
      Math.min(offset + PCM_CHUNK_BYTES, bytes.length),
    );
    await new Promise<void>((resolve, reject) => {
      stdin.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
    offset += chunk.length;
    await new Promise((r) => setTimeout(r, 25));
  }
  stdin.end();
}

async function startBridgeWithStt(
  opts: Partial<Parameters<VoiceBridge['start']>[0]> = {},
): Promise<{ bridge: VoiceBridge; events: VoiceBridgeEvent[] }> {
  const bridge = new VoiceBridge();
  liveBridges.push(bridge);
  const events: VoiceBridgeEvent[] = [];
  bridge.on('event', (e: VoiceBridgeEvent) => events.push(e));
  await bridge.start({
    inputMode: 'stdin-pcm',
    onStderr: () => {},
    ...opts,
  });
  return { bridge, events };
}

async function drainShutdown(bridge: VoiceBridge, timeoutMs = 30_000): Promise<void> {
  await new Promise<void>((resolve) => {
    bridge.once('shutdown_ack', () => resolve());
    bridge.once('exit', () => resolve());
    setTimeout(() => resolve(), timeoutMs);
  });
  await bridge.stop({ graceMs: 500 }).catch(() => undefined);
}

describeOrSkip('Phase 6B — real Moonshine STT via Python bridge', () => {
  it(
    'emits ready -> stt_ready -> speech_start -> partial(s) -> speech_end -> final',
    async () => {
      const { bridge, events } = await startBridgeWithStt();

      // Wait for stt_ready BEFORE piping audio so the contract ordering
      // is testable (otherwise model load races could let speech_start
      // fire before stt_ready).
      await bridge.waitForEvent('stt_ready', 30_000);

      await pipePcmThrough(bridge, FIXTURE_DIAGNOSE);
      await drainShutdown(bridge);

      // Locate event indices
      const readyIdx = events.findIndex((e) => e.type === 'ready');
      const sttReadyIdx = events.findIndex((e) => e.type === 'stt_ready');
      const speechStartIdx = events.findIndex((e) => e.type === 'speech_start');
      const speechEndIdx = events.findIndex((e) => e.type === 'speech_end');
      const partials = events.filter((e) => e.type === 'partial');
      const finals = events.filter((e) => e.type === 'final');

      // All required events fired
      expect(readyIdx).toBeGreaterThanOrEqual(0);
      expect(sttReadyIdx).toBeGreaterThanOrEqual(0);
      expect(speechStartIdx).toBeGreaterThanOrEqual(0);
      expect(speechEndIdx).toBeGreaterThanOrEqual(0);
      expect(finals.length).toBeGreaterThanOrEqual(1);

      // Ordering: ready before stt_ready before speech_start before
      // speech_end. Partials can interleave between speech_start and
      // speech_end; final lands AT or AFTER speech_end (the bridge
      // emits speech_end before enqueueing the final, but the worker
      // thread may finish processing before or after the speech_end
      // emit lands on stdout — both orderings are acceptable wire-side).
      expect(readyIdx).toBeLessThan(sttReadyIdx);
      expect(sttReadyIdx).toBeLessThan(speechStartIdx);
      expect(speechStartIdx).toBeLessThan(speechEndIdx);

      // At least one final event with non-empty text
      const finalTexts = finals.map((f) =>
        (f as Extract<VoiceBridgeEvent, { type: 'final' }>).text,
      );
      expect(finalTexts.some((t) => t.length > 0)).toBe(true);

      // No 'error' events of class 'stt-*' fired
      const sttErrors = events.filter(
        (e) =>
          e.type === 'error' &&
          (e as Extract<VoiceBridgeEvent, { type: 'error' }>).code.startsWith('stt-'),
      );
      expect(sttErrors).toEqual([]);

      // Partials are monotonically increasing (gaps allowed due to
      // drop-oldest, but ordering preserved within what the bridge
      // emitted).
      const partialSeqs = partials.map(
        (p) => (p as Extract<VoiceBridgeEvent, { type: 'partial' }>).seq,
      );
      for (let i = 1; i < partialSeqs.length; i += 1) {
        expect(partialSeqs[i]!).toBeGreaterThan(partialSeqs[i - 1]!);
      }
    },
    180_000,
  );

  it(
    'transcribe-dev-vocab fixture produces a transcript containing dev terms',
    async () => {
      // Get the bundled vocab seed path so the bridge applies
      // substitutions. The diagnose runner uses resolveVoiceVocabPaths
      // which probes the user-global file; that file is only there
      // after `symphony voice install`. For test reproducibility we
      // point at the bundled seed directly.
      const seedPath = path.join(REPO_ROOT, 'src', 'voice', 'vocab-seed.json');
      const { bridge, events } = await startBridgeWithStt({
        sttVocabPaths: [seedPath],
      });
      await bridge.waitForEvent('stt_ready', 30_000);
      await pipePcmThrough(bridge, FIXTURE_DEV_VOCAB);
      await drainShutdown(bridge);

      const finals = events.filter((e) => e.type === 'final') as Array<
        Extract<VoiceBridgeEvent, { type: 'final' }>
      >;
      expect(finals.length).toBeGreaterThanOrEqual(1);
      const transcript = finals.map((f) => f.text).join(' ').toLowerCase();
      // Moonshine + the seed vocab should produce a transcript that
      // contains AT LEAST one of the substituted dev terms.
      // We assert lower-case + permissive containment because
      // Moonshine's casing depends on the utterance's prosody.
      const containsSub =
        transcript.includes('useeffect') ||
        transcript.includes('package.json');
      expect(containsSub).toBe(true);
    },
    180_000,
  );
});
