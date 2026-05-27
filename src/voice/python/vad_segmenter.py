"""Silero VAD-driven speech segmenter (Phase 6A).

Wraps `silero_vad`'s ONNX model in a small state machine that emits
speech segment boundaries from a stream of fixed-size audio frames.

Design notes:
- Pure compute. No I/O, no threads. Caller drives the frame loop.
- Frame size is 30 ms (480 samples at 16 kHz mono). Silero v5 prefers
  32 ms (512 samples), but 30 ms keeps the math obvious with PyAudio /
  sounddevice block sizes and the WER hit on a Silero-only gate is nil.
- State machine: `idle` -> (run-up `min_speech_ms` above threshold)
  -> `speech` -> (run-down `min_silence_ms` below threshold) -> emit
  `speech_end` -> `idle`.
- Hysteresis matters. Without min-speech a single tongue click trips a
  segment; without min-silence two words sound like two segments.

The class is intentionally a single 200-line module so test coverage
is total and the failure modes are obvious.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterator, Optional


# ---------- public types ---------------------------------------------------


@dataclass(frozen=True)
class VadConfig:
    """Configuration for the VAD segmenter.

    Attributes
    ----------
    sample_rate:
        Frames must be at this rate. Silero v5 supports 16k and 8k; we
        commit to 16k for Symphony's full pipeline.
    frame_samples:
        Number of int16 samples per frame. 480 = 30 ms at 16 kHz.
    threshold:
        VAD probability above which a frame counts as speech. 0.5 is
        the Silero-recommended default; users in noisy environments
        bump this to 0.6-0.7 via config.
    min_speech_ms:
        Speech run-up before emitting `speech_start`. 100 ms filters
        single-tap noises.
    min_silence_ms:
        Silence run-down before emitting `speech_end`. 400 ms keeps
        natural pauses inside one segment.
    """

    sample_rate: int = 16000
    frame_samples: int = 480
    threshold: float = 0.5
    min_speech_ms: int = 100
    min_silence_ms: int = 400


@dataclass(frozen=True)
class SpeechStart:
    t_ms: int


@dataclass(frozen=True)
class SpeechEnd:
    t_ms: int
    duration_ms: int


VadEvent = SpeechStart | SpeechEnd

# Function signature for the VAD probability oracle. The segmenter
# accepts ANY callable that returns a probability for a given frame —
# this is the DI seam that keeps unit tests independent of the real
# Silero model.
VadProbFn = Callable[[bytes], float]


# ---------- segmenter ------------------------------------------------------


class VadSegmenter:
    """State machine that converts (frame -> probability) pairs into
    speech_start / speech_end events.

    Parameters
    ----------
    config:
        Frame size, threshold, hysteresis. See ``VadConfig``.
    vad_prob:
        Callable returning a 0..1 probability of speech for one frame.
        Inject the real Silero model for production; inject a fake for
        unit tests.

    Notes
    -----
    Time is tracked in millisecond integers, NOT floats — float drift
    over a long always-capture session is a real bug. The frame
    duration is integer-derived: ``frame_samples * 1000 // sample_rate``
    must divide evenly (it does for 16k / 480 = 30 ms).
    """

    def __init__(self, config: VadConfig, vad_prob: VadProbFn) -> None:
        self._cfg = config
        self._vad_prob = vad_prob
        self._frame_ms = config.frame_samples * 1000 // config.sample_rate
        # State
        self._t_ms = 0
        self._in_speech = False
        # Counters for run-up / run-down hysteresis, in milliseconds.
        self._speech_run_ms = 0
        self._silence_run_ms = 0
        # Track where the current speech segment started (for duration).
        self._speech_start_t_ms: Optional[int] = None

    @property
    def frame_ms(self) -> int:
        return self._frame_ms

    @property
    def t_ms(self) -> int:
        """Current wall-clock since start, in ms (advances per frame)."""
        return self._t_ms

    def set_threshold(self, value: float) -> None:
        """Update the speech-detection threshold at runtime (6E hook).

        Out-of-range values are clamped to [0, 1] rather than raising —
        the threshold is a user-tunable knob, and rejecting an off-by-one
        from the TUI would surface as a worse UX than a soft clamp.
        """
        if value < 0:
            value = 0.0
        elif value > 1:
            value = 1.0
        self._cfg = VadConfig(
            sample_rate=self._cfg.sample_rate,
            frame_samples=self._cfg.frame_samples,
            threshold=value,
            min_speech_ms=self._cfg.min_speech_ms,
            min_silence_ms=self._cfg.min_silence_ms,
        )

    def reset(self) -> None:
        """Drop all state. Used by the bridge on a `set_threshold`
        followed by a fresh segment, or after an `error` recovery."""
        self._t_ms = 0
        self._in_speech = False
        self._speech_run_ms = 0
        self._silence_run_ms = 0
        self._speech_start_t_ms = None

    def push(self, frame: bytes) -> Iterator[VadEvent]:
        """Push one frame of PCM bytes. Yields zero or one event.

        Frame length must match ``frame_samples * 2`` (int16 samples).
        Mis-sized frames raise ``ValueError`` — callers MUST chunk audio
        at the configured size, not pass arbitrary buffers.
        """
        expected = self._cfg.frame_samples * 2
        if len(frame) != expected:
            raise ValueError(
                f"frame size mismatch: got {len(frame)} bytes, expected {expected} "
                f"({self._cfg.frame_samples} int16 samples)"
            )

        prob = self._vad_prob(frame)
        is_speech = prob >= self._cfg.threshold

        # Advance wall clock BEFORE state update so emitted events
        # carry the timestamp of the frame's TRAILING edge.
        self._t_ms += self._frame_ms

        if not self._in_speech:
            # State: idle / running up to speech
            if is_speech:
                self._speech_run_ms += self._frame_ms
                self._silence_run_ms = 0
                if self._speech_run_ms >= self._cfg.min_speech_ms:
                    # Backdate the start to where the run-up began.
                    start_t = self._t_ms - self._speech_run_ms
                    self._speech_start_t_ms = start_t
                    self._in_speech = True
                    self._silence_run_ms = 0
                    yield SpeechStart(t_ms=start_t)
            else:
                # Idle frame — reset the run-up counter.
                self._speech_run_ms = 0
        else:
            # State: in_speech / running down to silence
            if is_speech:
                # More speech; reset silence run-down.
                self._silence_run_ms = 0
            else:
                self._silence_run_ms += self._frame_ms
                if self._silence_run_ms >= self._cfg.min_silence_ms:
                    # End of segment. Backdate end to where silence began
                    # so the segment duration reflects speech, not the
                    # trailing silence buffer.
                    end_t = self._t_ms - self._silence_run_ms
                    start_t = self._speech_start_t_ms or 0
                    duration = max(0, end_t - start_t)
                    self._in_speech = False
                    self._speech_run_ms = 0
                    self._silence_run_ms = 0
                    self._speech_start_t_ms = None
                    yield SpeechEnd(t_ms=end_t, duration_ms=duration)
