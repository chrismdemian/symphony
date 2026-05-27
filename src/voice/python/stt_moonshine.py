"""Moonshine STT wrapper for Symphony's voice bridge (Phase 6B).

Thin, torch-free shim over ``useful-moonshine-onnx``. Holds a lazily
loaded model for the process lifetime and exposes one entry point:
``transcribe(audio_f32: np.ndarray) -> str``.

Design notes:
- Package is ``useful-moonshine-onnx`` (NOT ``moonshine-voice`` —
  that one bundles native libs via ctypes and breaks Symphony's
  torch-free / pure-onnxruntime invariant). Module import name is
  ``moonshine_onnx``.
- Models: ``moonshine/base`` (61M, ~5% WER) default; ``moonshine/tiny``
  (27M, ~13% WER) for low-resource edge.
- Cold start: ``moonshine_onnx.transcribe`` lazy-loads ONNX sessions
  + tokenizer on FIRST call, downloading from HF Hub anonymously to
  ``~/.cache/huggingface/`` (cache hit on subsequent calls).
- Numba JIT pause: ``librosa`` (a transitive dep) triggers numba
  compilation on first inference. Cold-start budget is 3-8 s. The
  bridge runs a 1-second silence warm-up on the worker thread BEFORE
  emitting ``stt_ready`` so the first real utterance doesn't eat that
  pause.
- The model load + first warm-up infer are blocking. Callers (the
  bridge's worker thread) own threading.
- All audio comes in as a float32 numpy array in [-1, 1] at 16 kHz
  mono. int16 -> float32 conversion lives at the bridge layer.
"""
from __future__ import annotations

from typing import Optional

import numpy as np


SUPPORTED_MODELS = frozenset({"moonshine/base", "moonshine/tiny"})


class MoonshineTranscriber:
    """Lazy-loading Moonshine wrapper. One instance per bridge lifetime."""

    def __init__(self, model: str = "moonshine/base") -> None:
        if model not in SUPPORTED_MODELS:
            raise ValueError(
                f"unsupported model {model!r}; expected one of "
                f"{sorted(SUPPORTED_MODELS)}"
            )
        self._model_id = model
        self._loaded = False
        # Imported lazily so the bridge can boot even without
        # `useful-moonshine-onnx` installed (the 6B installer runs an
        # import smoke separately).
        self._moonshine_onnx = None  # type: ignore[assignment]

    @property
    def model_id(self) -> str:
        return self._model_id

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        """Import ``moonshine_onnx``, prep cache. Idempotent.

        Naming gotcha: the PyPI package is ``useful-moonshine-onnx`` (the
        thing pip installs); the Python MODULE name is ``moonshine_onnx``
        (no ``useful_`` prefix). Imports are by module name.
        """
        if self._loaded:
            return
        try:
            import moonshine_onnx  # type: ignore[import-not-found]
        except ImportError as e:
            raise MoonshineLoadError(
                f"moonshine_onnx module not importable: {e!r}. "
                "Run `symphony voice install` (installs useful-moonshine-onnx)."
            ) from e
        self._moonshine_onnx = moonshine_onnx
        self._loaded = True

    def warmup(self) -> None:
        """Run a single silence-buffer inference to warm numba JIT.

        Eats the 3-8 s pause that would otherwise hit the FIRST real
        user utterance. The bridge calls this on the worker thread
        before emitting ``stt_ready``.
        """
        if not self._loaded:
            self.load()
        # 1-second silence buffer at 16 kHz mono. 1-D (N,) shape;
        # moonshine_onnx.transcribe adds the batch dim internally.
        silence = np.zeros(16000, dtype=np.float32)
        try:
            self._call_transcribe(silence)
        except Exception as e:  # noqa: BLE001
            # Warm-up failure is fatal — if the FIRST inference can't
            # run, there's no recovery. Caller surfaces via stderr +
            # 'error' event.
            raise MoonshineWarmupError(
                f"warmup inference failed: {type(e).__name__}: {e!r}"
            ) from e

    def transcribe(self, audio_f32: np.ndarray) -> str:
        """Transcribe one buffered utterance. Returns plain text.

        ``audio_f32`` must be a numpy float32 array at 16 kHz mono.
        Shape may be (N,) or (1, N) — both accepted, NORMALIZED to
        1-D (N,) for the underlying call.

        Naming gotcha: ``moonshine_onnx.transcribe`` runs
        ``audio[None, ...]`` internally to add the batch dim, so it
        wants a 1-D array. Passing a 2-D ``(1, N)`` array makes it
        3-D internally and trips
        ``assert len(audio.shape) == 2``. Confirmed empirically on
        useful-moonshine-onnx==20251121.
        """
        if not self._loaded:
            self.load()
        if audio_f32.dtype != np.float32:
            raise TypeError(
                f"audio dtype must be float32, got {audio_f32.dtype}"
            )
        if audio_f32.ndim == 1:
            payload = audio_f32
        elif audio_f32.ndim == 2 and audio_f32.shape[0] == 1:
            payload = audio_f32[0]
        else:
            raise ValueError(
                f"audio shape must be (N,) or (1, N), got {audio_f32.shape!r}"
            )
        return self._call_transcribe(payload)

    def _call_transcribe(self, payload: np.ndarray) -> str:
        assert self._moonshine_onnx is not None
        result = self._moonshine_onnx.transcribe(payload, self._model_id)
        # `moonshine_onnx.transcribe` returns list[str]; one entry per
        # batch row. We always batch=1.
        if isinstance(result, (list, tuple)):
            return str(result[0]) if result else ""
        return str(result)


def int16_pcm_to_float32(pcm_bytes: bytes) -> np.ndarray:
    """Convert raw int16 LE mono PCM bytes to a float32 numpy array in [-1, 1].

    Shape: (N,). Caller passes through to ``MoonshineTranscriber.transcribe``
    which reshapes to (1, N). Empty input returns an empty (0,) array
    so callers can detect "no audio" without a separate length check.
    """
    if not pcm_bytes:
        return np.zeros((0,), dtype=np.float32)
    arr = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    return arr


class MoonshineLoadError(Exception):
    """Raised when ``useful-moonshine-onnx`` cannot be imported."""


class MoonshineWarmupError(Exception):
    """Raised when the first warm-up inference fails."""
