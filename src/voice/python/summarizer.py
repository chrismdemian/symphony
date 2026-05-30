"""Local T5 summarizer for Symphony's rolling context buffer (Phase 6D.2).

Torch-free abstractive summarizer over the ONNX-exported T5-small
summarization fine-tune ``onnx-community/text_summarization-ONNX``,
driven by raw ``onnxruntime`` + the ``tokenizers`` (Rust) library doing
greedy decoding. No torch, no ``optimum``, no ``transformers`` generation
utils — the same torch-free invariant as the STT path
(``stt_moonshine.py``). ``tokenizers`` is already a transitive dep of the
STT stack (``useful-moonshine-onnx``).

Used by the Node ``LocalSummarizer`` wrapper to compact aged ambient
transcripts locally (no cloud, no tokens — the "no LLM traffic on
ambient input" mandate means *no cloud* LLM; a local model is fine).

Wire protocol (newline-delimited JSON on stdin/stdout):
  - on boot: load the model, emit ``{"type":"ready"}`` (or
    ``{"type":"error","fatal":true,"message":...}`` then exit 1).
  - command: ``{"cmd":"summarize","id":N,"texts":[...]}`` ->
    ``{"type":"summary","id":N,"text":"..."}`` (or
    ``{"type":"error","id":N,"message":...}`` on a non-fatal failure;
    the Node side falls back to its heuristic on either).
  - command: ``{"cmd":"shutdown"}`` -> ``{"type":"shutdown_ack"}`` + exit 0.

Model facts (T5-small, verified against the repo config.json):
  - encoder ``onnx/encoder_model_int8.onnx``: inputs ``input_ids`` (int64),
    ``attention_mask`` (int64) -> ``last_hidden_state`` (f32 [1,L,512]).
  - decoder ``onnx/decoder_model_int8.onnx`` (NO-CACHE variant — re-runs the
    full growing sequence each step; simplest correct path, latency is not
    critical for background compaction): inputs ``input_ids`` (int64),
    ``encoder_attention_mask`` (int64), ``encoder_hidden_states`` (f32) ->
    ``logits`` (f32 [1,L,32128]).
  - ``decoder_start_token_id`` = 0 (pad); ``eos_token_id`` = 1 (</s>).
  - task prefix ``"summarize: "`` is MANDATORY (config task_specific_params).
  - max encoder input 512 tokens.
  - the repo ships ``tokenizer.json`` (a fast/Unigram tokenizer), NOT a
    raw ``spiece.model`` — ``tokenizers.Tokenizer.from_file`` loads it and
    its template post-processor appends ``</s>`` automatically.
"""
from __future__ import annotations

import json
import sys
from typing import List, Optional

import numpy as np


REPO_ID = "onnx-community/text_summarization-ONNX"
ENCODER_REL = "onnx/encoder_model_int8.onnx"
DECODER_REL = "onnx/decoder_model_int8.onnx"
TOKENIZER_REL = "tokenizer.json"

# Only the files the no-cache inference path needs — keeps the install
# download to ~144 MB instead of the repo's ~3.5 GB of variants.
ALLOW_PATTERNS = [
    ENCODER_REL,
    DECODER_REL,
    TOKENIZER_REL,
    "config.json",
    "generation_config.json",
    "special_tokens_map.json",
]

PREFIX = "summarize: "
DECODER_START_TOKEN_ID = 0
EOS_TOKEN_ID = 1
MAX_INPUT_TOKENS = 512
MAX_NEW_TOKENS = 200


class SummarizerLoadError(Exception):
    """Raised when the model files / runtime can't be loaded."""


class T5Summarizer:
    """Lazy-loading T5 ONNX summarizer. One instance per subprocess lifetime."""

    def __init__(self, model_dir: Optional[str] = None) -> None:
        self._model_dir = model_dir
        self._loaded = False
        self._enc = None
        self._dec = None
        self._tok = None

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def _resolve_model_dir(self) -> str:
        if self._model_dir is not None:
            return self._model_dir
        # Resolve the already-downloaded snapshot WITHOUT hitting the
        # network (the installer pre-downloads). local_files_only=True
        # raises if the files aren't cached -> a clean "model missing"
        # signal the Node side turns into a heuristic fallback.
        try:
            from huggingface_hub import snapshot_download  # type: ignore
        except ImportError as e:  # pragma: no cover - install-time guard
            raise SummarizerLoadError(
                f"huggingface_hub not importable: {e!r}"
            ) from e
        return snapshot_download(
            REPO_ID, allow_patterns=ALLOW_PATTERNS, local_files_only=True
        )

    def load(self) -> None:
        """Load both ONNX sessions + the SentencePiece tokenizer. Idempotent."""
        if self._loaded:
            return
        import os

        try:
            import onnxruntime as ort  # type: ignore
            from tokenizers import Tokenizer  # type: ignore
        except ImportError as e:
            raise SummarizerLoadError(
                f"summarizer deps not importable: {e!r}. "
                "Run `symphony voice install` (installs tokenizers + the model)."
            ) from e

        model_dir = self._resolve_model_dir()
        enc_path = os.path.join(model_dir, ENCODER_REL)
        dec_path = os.path.join(model_dir, DECODER_REL)
        tok_path = os.path.join(model_dir, TOKENIZER_REL)
        for p in (enc_path, dec_path, tok_path):
            if not os.path.isfile(p):
                raise SummarizerLoadError(f"model file missing: {p}")

        # Single-threaded, CPU-only — background compaction, not latency
        # critical, and we never want it to contend with the audio path.
        so = ort.SessionOptions()
        so.intra_op_num_threads = 1
        so.inter_op_num_threads = 1
        providers = ["CPUExecutionProvider"]
        self._enc = ort.InferenceSession(enc_path, sess_options=so, providers=providers)
        self._dec = ort.InferenceSession(dec_path, sess_options=so, providers=providers)
        self._tok = Tokenizer.from_file(tok_path)
        self._loaded = True

    def _tokenize(self, text: str) -> np.ndarray:
        assert self._tok is not None
        # The tokenizer's template post-processor already appends </s>.
        ids = list(self._tok.encode(text).ids)
        if len(ids) > MAX_INPUT_TOKENS:
            ids = ids[:MAX_INPUT_TOKENS]
            ids[-1] = EOS_TOKEN_ID  # preserve the sequence boundary
        return np.array([ids], dtype=np.int64)

    def _detokenize(self, ids: List[int]) -> str:
        assert self._tok is not None
        return str(self._tok.decode(list(ids), skip_special_tokens=True)).strip()

    def summarize(self, texts: List[str]) -> str:
        """Summarize a batch of utterances into one compact paragraph.

        Joins the utterances, prepends the mandatory ``summarize: ``
        prefix, runs encoder once + greedy decode. Returns ``""`` for
        empty input (the caller treats that as "nothing to summarize").
        """
        joined = " ".join(t.strip() for t in texts if t and t.strip())
        if not joined:
            return ""  # nothing to summarize — never loads the model

        if not self._loaded:
            self.load()
        assert self._enc is not None and self._dec is not None

        input_ids = self._tokenize(PREFIX + joined)
        attention_mask = np.ones_like(input_ids, dtype=np.int64)

        encoder_hidden_states = self._enc.run(
            None, {"input_ids": input_ids, "attention_mask": attention_mask}
        )[0]

        decoder_input_ids = np.array([[DECODER_START_TOKEN_ID]], dtype=np.int64)
        generated: List[int] = []
        for _ in range(MAX_NEW_TOKENS):
            logits = self._dec.run(
                None,
                {
                    "input_ids": decoder_input_ids,
                    "encoder_attention_mask": attention_mask,
                    "encoder_hidden_states": encoder_hidden_states,
                },
            )[0]
            next_token_id = int(np.argmax(logits[0, -1, :]))
            if next_token_id == EOS_TOKEN_ID:
                break
            generated.append(next_token_id)
            decoder_input_ids = np.concatenate(
                [decoder_input_ids, np.array([[next_token_id]], dtype=np.int64)],
                axis=1,
            )

        return self._detokenize(generated)


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main(argv: Optional[List[str]] = None) -> int:
    """Run the newline-delimited JSON protocol loop over stdin/stdout."""
    argv = list(sys.argv[1:] if argv is None else argv)
    model_dir: Optional[str] = None
    for i, a in enumerate(argv):
        if a == "--model-dir" and i + 1 < len(argv):
            model_dir = argv[i + 1]

    summarizer = T5Summarizer(model_dir=model_dir)
    try:
        summarizer.load()
    except Exception as e:  # noqa: BLE001 - any load failure is fatal here
        _emit({"type": "error", "fatal": True, "message": f"{type(e).__name__}: {e}"})
        return 1
    _emit({"type": "ready"})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue  # ignore transport noise (mirrors the bridge)
        if not isinstance(msg, dict):
            continue  # valid JSON but not a command object (audit-m1)
        cmd = msg.get("cmd")
        if cmd == "shutdown":
            _emit({"type": "shutdown_ack"})
            return 0
        if cmd == "summarize":
            req_id = msg.get("id")
            texts = msg.get("texts") or []
            if not isinstance(texts, list):
                texts = []
            try:
                text = summarizer.summarize([str(t) for t in texts])
                _emit({"type": "summary", "id": req_id, "text": text})
            except Exception as e:  # noqa: BLE001 - non-fatal; Node falls back
                _emit(
                    {
                        "type": "error",
                        "id": req_id,
                        "message": f"{type(e).__name__}: {e}",
                    }
                )
    return 0


if __name__ == "__main__":
    sys.exit(main())
