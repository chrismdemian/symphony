"""Phase 6C — wake-word detector.

Wraps `openwakeword.Model` with Symphony's sustain + cooldown logic. Runs on
the main bridge thread alongside Silero VAD; openWakeWord inference is ~1 ms
per 80 ms window on CPU, well within Silero's 32 ms frame budget.

Wire shape (mirrors VadSegmenter):
    detector = WakeWordDetector(WakeWordConfig(...), model_path)
    fire = detector.push(frame_bytes)  # called for every 512-sample Silero frame
    if fire is not None:
        emit({"type":"wake_word", "model":fire.model, "score":fire.score, ...})

The detector accumulates Silero's 512-sample (32 ms) frames into a
1280-sample (80 ms) ring buffer, the size openWakeWord prefers. Every time
the ring fills, we call `model.predict(...)` and apply:

  - **Threshold sustain**: require N consecutive predictions above threshold
    before emitting a fire (default N=3 = 240 ms). Drops single-frame
    false positives common to openWakeWord.
  - **Cooldown**: after a fire, suppress further fires for N ms (default
    2000). Prevents one utterance from triggering 5 fires in 400 ms.

Test seam: `predict_fn` arg replaces the real openwakeword.Model with any
callable `(int16_ndarray) -> dict[str, float]`. Lets unit tests assert
the sustain/cooldown logic without loading the real ONNX model.
"""
from __future__ import annotations

import collections
import os
from dataclasses import dataclass, field
from typing import Callable, Dict, Optional


# Default wake-word window per openWakeWord docs: 1280 samples = 80 ms at 16 kHz.
DEFAULT_WINDOW_SAMPLES = 1280


@dataclass(frozen=True)
class WakeWordConfig:
    """Tunable knobs for the detector.

    All thresholds + cadences are exposed so the bridge's argv layer can
    pass them through from Symphony's voice.* config object.
    """
    sample_rate: int = 16000
    frame_samples: int = 512        # Silero VAD frame size; the bridge's grain
    window_samples: int = DEFAULT_WINDOW_SAMPLES  # openWakeWord prediction size
    threshold: float = 0.5          # score above which a frame counts as "hit"
    sustain_frames: int = 3         # consecutive hits required to fire
    cooldown_ms: int = 2000         # silence after a fire
    model_name: str = "hey-symphony"  # informational; surfaces in the event


@dataclass(frozen=True)
class WakeWordFire:
    """Emitted when the detector commits to a wake-word event."""
    model: str
    score: float
    t_ms: int


# Type alias for the predict callable; matches openwakeword.Model.predict's
# `(int16_audio: np.ndarray) -> dict[str, float]` shape.
PredictFn = Callable[["object"], Dict[str, float]]  # object placeholder to avoid forced numpy import


@dataclass
class _State:
    """Mutable detector state."""
    t_ms: int = 0
    buffer: bytearray = field(default_factory=bytearray)
    consecutive_hits: int = 0
    cooldown_until_t_ms: int = 0
    last_score_above_threshold: float = 0.0


class WakeWordDetector:
    """Threshold-sustain + cooldown wake-word detector.

    The class is intentionally I/O-free — it accepts already-decoded int16
    audio frames and returns events. Bridge does the audio plumbing.

    Construct, then call `push(frame_bytes)` for every frame received from
    the bridge's audio iterator. Returns a `WakeWordFire` event when the
    sustain + cooldown logic commits to a detection; returns None otherwise.

    Disable path: when the bridge is started with `--no-wakeword` (or the
    default — wake-word is opt-in), the bridge simply doesn't instantiate
    this class. There's no in-class `enabled=False` flag because that would
    waste an import of openwakeword.
    """

    def __init__(
        self,
        config: WakeWordConfig,
        model_path: str,
        *,
        predict_fn: Optional[PredictFn] = None,
    ) -> None:
        """Build the detector.

        :param config: thresholds + cadences.
        :param model_path: absolute path to a `<name>.onnx` wake-word model.
            Validated at construction time so a bad path fails loud at
            bridge boot rather than silently at first frame.
        :param predict_fn: TEST SEAM. When provided, used instead of
            openwakeword.Model. Signature: `(int16_ndarray) -> {name: score}`.
            Production code leaves this None.
        """
        self._config = config
        self._model_path = model_path
        self._state = _State()
        self._frame_ms = config.frame_samples * 1000 // config.sample_rate
        self._predict_fn = predict_fn

        if predict_fn is None:
            self._predict_fn = self._build_openwakeword_predict_fn(model_path)

    def _build_openwakeword_predict_fn(self, model_path: str) -> PredictFn:
        """Lazy-load openwakeword + return a predict callable bound to its Model.

        Lazy because we only want to pay the openwakeword import cost AND
        the ONNX session-init cost when wake-word is actually enabled.
        Importing at module top-level would force every bridge-without-wake
        spawn to pay it.
        """
        if not os.path.exists(model_path):
            raise WakeWordModelMissingError(
                f"wake-word model not found: {model_path}. "
                f"Did the build copy `assets/wake-models/*.onnx` into dist/? "
                f"See tsup.config.ts onSuccess.",
            )
        try:
            from openwakeword.model import Model  # type: ignore[import-not-found]
        except ImportError as e:
            raise WakeWordModelMissingError(
                f"openwakeword not installed in the voice venv: {e}. "
                f"Run `symphony voice install`.",
            ) from e

        model = Model(
            wakeword_models=[model_path],
            inference_framework="onnx",   # tflite isn't available on Win32
            vad_threshold=0.0,            # we have our own VAD via Silero (6A)
        )

        def _predict(audio_int16: "object") -> Dict[str, float]:
            return dict(model.predict(audio_int16))

        return _predict

    @property
    def config(self) -> WakeWordConfig:
        return self._config

    def reset(self) -> None:
        """Clear internal state — used by the bridge on error recovery."""
        self._state = _State()

    def push(self, frame_bytes: bytes) -> Optional[WakeWordFire]:
        """Feed one Silero frame (default 512 samples × int16 = 1024 bytes).

        Returns a `WakeWordFire` event iff the sustain + cooldown logic
        commits to a detection. Returns None otherwise.

        The detector ring-buffers Silero frames until it has at least
        `window_samples` samples, then predicts on the most recent
        `window_samples`-sized slice, slides the buffer forward by the
        slice length, and repeats. This means the prediction cadence is
        ~80 ms even though the bridge feeds 32 ms frames.
        """
        s = self._state
        cfg = self._config
        # Advance monotonic time before any short-circuit so callers that
        # rely on `t_ms` (e.g. tests) see consistent progress.
        s.t_ms += self._frame_ms

        s.buffer.extend(frame_bytes)
        # Each sample is 2 bytes (int16 LE).
        bytes_per_window = cfg.window_samples * 2

        # Buffer hasn't reached a full window yet; nothing to predict.
        if len(s.buffer) < bytes_per_window:
            return None

        # We may have multiple windows accumulated (e.g. if upstream paused);
        # process them all to keep the buffer bounded.
        fire: Optional[WakeWordFire] = None
        while len(s.buffer) >= bytes_per_window:
            window = bytes(s.buffer[:bytes_per_window])
            del s.buffer[:bytes_per_window]
            fire = self._process_window(window) or fire

        return fire

    def _process_window(self, window_bytes: bytes) -> Optional[WakeWordFire]:
        """Run prediction on one `window_samples`-sized slice + apply logic."""
        s = self._state
        cfg = self._config

        # Cooldown: don't predict / don't fire during the silence window.
        # We still consume buffer so the detector resyncs cleanly when
        # cooldown ends.
        if s.t_ms < s.cooldown_until_t_ms:
            return None

        # int16 LE bytes -> numpy int16 array. openwakeword's `Model.predict`
        # accepts int16 ndarray directly (no float conversion needed).
        import numpy as np  # type: ignore[import-not-found]

        audio = np.frombuffer(window_bytes, dtype=np.int16)
        assert self._predict_fn is not None  # set in __init__
        scores = self._predict_fn(audio)

        # openWakeWord returns {wake_word_name: score} for every loaded model.
        # We loaded ONE model; pick its score. If multiple were loaded (future
        # multi-phrase support), pick the max — that's the wake-up signal.
        if not scores:
            return None
        best_name, best_score = max(scores.items(), key=lambda kv: kv[1])

        if best_score >= cfg.threshold:
            s.consecutive_hits += 1
            s.last_score_above_threshold = best_score
            if s.consecutive_hits >= cfg.sustain_frames:
                # Commit to a fire.
                fire = WakeWordFire(
                    model=cfg.model_name,
                    score=s.last_score_above_threshold,
                    t_ms=s.t_ms,
                )
                s.consecutive_hits = 0
                s.last_score_above_threshold = 0.0
                s.cooldown_until_t_ms = s.t_ms + cfg.cooldown_ms
                return fire
        else:
            # Reset sustain counter on a below-threshold frame.
            s.consecutive_hits = 0
            s.last_score_above_threshold = 0.0

        return None

    # --- diagnostics (used by tests + manual debug) ----------------------

    @property
    def t_ms(self) -> int:
        return self._state.t_ms

    @property
    def consecutive_hits(self) -> int:
        return self._state.consecutive_hits

    @property
    def in_cooldown(self) -> bool:
        return self._state.t_ms < self._state.cooldown_until_t_ms


class WakeWordModelMissingError(RuntimeError):
    """Raised when the .onnx model or the openwakeword package can't be loaded.

    Surfaced as a bridge `error` event with code `wake-word-load-failed`.
    """
