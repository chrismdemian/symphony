/**
 * Phase 6D.2 integration — real T5 ONNX summarizer via the real
 * `summarizer.py` subprocess driven by `LocalSummarizer`. Asserts the
 * local model produces a genuine abstractive summary (distinct from the
 * heuristic join) and that the instance never degrades on the happy path.
 *
 * Skip-gracefully when the voice venv / tokenizers / model aren't present
 * (run `symphony voice install` — downloads ~144MB on first run).
 */
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalSummarizer } from '../../src/voice/summarizer.js';
import { resolveVoiceEnv } from '../../src/voice/env.js';
import { heuristicSummarize } from '../../src/state/transcript-store.js';

const ALLOW =
  "['onnx/encoder_model_int8.onnx','onnx/decoder_model_int8.onnx'," +
  "'tokenizer.json','config.json','generation_config.json','special_tokens_map.json']";

function probe(): { available: boolean; reason?: string } {
  const summary = resolveVoiceEnv();
  if (!summary.exists) return { available: false, reason: 'venv missing' };
  const check = spawnSync(
    summary.pythonPath,
    [
      '-c',
      'import onnxruntime, tokenizers; from huggingface_hub import snapshot_download; ' +
        `snapshot_download('onnx-community/text_summarization-ONNX', allow_patterns=${ALLOW}, local_files_only=True)`,
    ],
    { encoding: 'utf8' },
  );
  if (check.status !== 0) {
    return { available: false, reason: 'tokenizers/model not cached (run `symphony voice install`)' };
  }
  return { available: true };
}

const p = probe();
const describeOrSkip = p.available ? describe : describe.skip;
if (!p.available) console.warn(`[6d2-integration] skipping: ${p.reason}.`);

const live: LocalSummarizer[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) await s.close().catch(() => undefined);
});

describeOrSkip('Phase 6D.2 — LocalSummarizer drives the real T5 ONNX model', () => {
  it(
    'produces a genuine abstractive summary (distinct from the heuristic)',
    async () => {
      const s = new LocalSummarizer({ readyTimeoutMs: 60_000, summarizeTimeoutMs: 60_000 });
      live.push(s);
      const texts = [
        'I need to refactor the authentication module.',
        'We should also update the login flow and add tests.',
        'The session handling has a bug with token expiry.',
      ];
      const out = await s.summarize(texts);
      expect(s.isDegraded).toBe(false);
      expect(out.length).toBeGreaterThan(0);
      // The model paraphrases — its output differs from the heuristic's
      // raw join, proving the LLM path actually ran.
      expect(out).not.toBe(heuristicSummarize(texts));
    },
    120_000,
  );

  it(
    'returns "" for empty input without degrading',
    async () => {
      const s = new LocalSummarizer({ readyTimeoutMs: 60_000 });
      live.push(s);
      const out = await s.summarize(['', '   ']);
      expect(out).toBe('');
      expect(s.isDegraded).toBe(false);
    },
    120_000,
  );
});
