"""pytest suite for ``vad_segmenter.py``.

Pure-Python tests: the VAD probability function is injected as a
callable so no Silero model is needed. Driven by deterministic
synthetic frame streams.

Run via the voice venv's pytest:
    ~/.symphony/voice-env/bin/pytest tests/voice/python/

In CI / dev without a venv: install pytest globally (`pip install pytest`)
and run from the repo root.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Add the python source dir so the test can `import vad_segmenter` without
# the bridge installer being run.
HERE = Path(__file__).resolve().parent
SRC_DIR = HERE.parents[2] / "src" / "voice" / "python"
sys.path.insert(0, str(SRC_DIR))

import pytest  # noqa: E402

from vad_segmenter import (  # noqa: E402
    SpeechEnd,
    SpeechStart,
    VadConfig,
    VadSegmenter,
)


def silence_frame(frame_samples: int = 480) -> bytes:
    """Return ``frame_samples`` int16 zeros."""
    return b"\x00\x00" * frame_samples


def speech_frame(frame_samples: int = 480) -> bytes:
    """Same shape, with sufficient amplitude to register as speech
    if the VAD oracle was real. With our injected prob_fn we don't
    care about the bytes; this is just a marker."""
    return b"\x10\x00" * frame_samples


def static_prob(prob: float):
    """Build a probability function that returns ``prob`` regardless
    of frame content. Used for run-up / run-down hysteresis tests."""

    def _fn(frame: bytes) -> float:
        return prob

    return _fn


def stepwise_prob(probabilities: list[float]):
    """Probability function that returns ``probabilities`` in sequence,
    one per call. After exhaustion returns 0.0 (silence) — caller is
    responsible for shaping the list to match the frame stream."""
    idx = [0]

    def _fn(frame: bytes) -> float:
        i = idx[0]
        idx[0] += 1
        if i >= len(probabilities):
            return 0.0
        return probabilities[i]

    return _fn


def drive(segmenter: VadSegmenter, frames: list[bytes]):
    """Push every frame, collect events in order."""
    events = []
    for f in frames:
        events.extend(list(segmenter.push(f)))
    return events


# --- frame_ms math ---------------------------------------------------------


def test_frame_ms_30():
    cfg = VadConfig(sample_rate=16000, frame_samples=480)
    seg = VadSegmenter(cfg, static_prob(0.0))
    assert seg.frame_ms == 30


def test_frame_ms_20():
    cfg = VadConfig(sample_rate=16000, frame_samples=320)
    seg = VadSegmenter(cfg, static_prob(0.0))
    assert seg.frame_ms == 20


def test_frame_size_mismatch_raises():
    cfg = VadConfig(sample_rate=16000, frame_samples=480)
    seg = VadSegmenter(cfg, static_prob(0.0))
    with pytest.raises(ValueError, match="frame size mismatch"):
        list(seg.push(b"\x00" * 8))


# --- idle when below threshold --------------------------------------------


def test_silence_never_emits():
    cfg = VadConfig(sample_rate=16000, frame_samples=480, threshold=0.5)
    seg = VadSegmenter(cfg, static_prob(0.0))
    events = drive(seg, [silence_frame() for _ in range(100)])
    assert events == []


# --- speech run-up to start -----------------------------------------------


def test_speech_run_up_triggers_start():
    # 100ms min_speech, 30ms per frame => 4 frames above threshold
    cfg = VadConfig(
        sample_rate=16000, frame_samples=480, threshold=0.5,
        min_speech_ms=100, min_silence_ms=400,
    )
    seg = VadSegmenter(cfg, static_prob(0.9))
    # Push 5 speech frames; expect exactly one speech_start
    events = drive(seg, [speech_frame() for _ in range(5)])
    starts = [e for e in events if isinstance(e, SpeechStart)]
    ends = [e for e in events if isinstance(e, SpeechEnd)]
    assert len(starts) == 1
    assert len(ends) == 0


def test_below_min_speech_does_not_trigger():
    cfg = VadConfig(
        sample_rate=16000, frame_samples=480, threshold=0.5,
        min_speech_ms=150, min_silence_ms=400,
    )
    # 150ms = 5 frames; we feed only 3 speech frames then back to silence.
    # The single-tap noise is the canonical failure mode this defends against.
    seg = VadSegmenter(cfg, stepwise_prob([0.9, 0.9, 0.9] + [0.0] * 30))
    events = drive(seg, [speech_frame() for _ in range(33)])
    assert events == []


# --- speech end on silence run-down ----------------------------------------


def test_speech_end_after_silence_run_down():
    cfg = VadConfig(
        sample_rate=16000, frame_samples=480, threshold=0.5,
        min_speech_ms=100, min_silence_ms=400,
    )
    # 10 frames speech, then 20 frames silence (600ms > min_silence_ms)
    seg = VadSegmenter(
        cfg, stepwise_prob([0.9] * 10 + [0.0] * 20),
    )
    events = drive(seg, [speech_frame() for _ in range(30)])
    starts = [e for e in events if isinstance(e, SpeechStart)]
    ends = [e for e in events if isinstance(e, SpeechEnd)]
    assert len(starts) == 1
    assert len(ends) == 1


def test_brief_silence_does_not_end_segment():
    """A 200ms pause (< 400ms min_silence_ms) keeps the segment open."""
    cfg = VadConfig(
        sample_rate=16000, frame_samples=480, threshold=0.5,
        min_speech_ms=100, min_silence_ms=400,
    )
    # speech 10 frames -> silence 5 frames (150ms < 400ms) -> speech 10 -> silence 20
    pattern = [0.9] * 10 + [0.0] * 5 + [0.9] * 10 + [0.0] * 20
    seg = VadSegmenter(cfg, stepwise_prob(pattern))
    events = drive(seg, [speech_frame() for _ in range(45)])
    starts = [e for e in events if isinstance(e, SpeechStart)]
    ends = [e for e in events if isinstance(e, SpeechEnd)]
    assert len(starts) == 1
    assert len(ends) == 1


# --- two distinct segments -------------------------------------------------


def test_two_segments_emitted():
    """speech / long-silence / speech / long-silence => 2 segments."""
    cfg = VadConfig(
        sample_rate=16000, frame_samples=480, threshold=0.5,
        min_speech_ms=100, min_silence_ms=400,
    )
    pattern = [0.9] * 10 + [0.0] * 20 + [0.9] * 10 + [0.0] * 20
    seg = VadSegmenter(cfg, stepwise_prob(pattern))
    events = drive(seg, [speech_frame() for _ in range(60)])
    starts = [e for e in events if isinstance(e, SpeechStart)]
    ends = [e for e in events if isinstance(e, SpeechEnd)]
    assert len(starts) == 2
    assert len(ends) == 2
    # Second start MUST be after first end
    assert starts[1].t_ms >= ends[0].t_ms


# --- set_threshold runtime adjust -----------------------------------------


def test_set_threshold_clamps_to_zero():
    cfg = VadConfig(threshold=0.5)
    seg = VadSegmenter(cfg, static_prob(0.0))
    seg.set_threshold(-1.0)
    # No public getter, but pushing speech that would pass even
    # threshold=0 should now succeed
    cfg2 = VadConfig(
        sample_rate=16000, frame_samples=480, threshold=0.5,
        min_speech_ms=30, min_silence_ms=400,
    )
    seg = VadSegmenter(cfg2, static_prob(0.05))  # below threshold 0.5
    events = drive(seg, [speech_frame() for _ in range(5)])
    assert events == []  # ignored at threshold 0.5
    seg.set_threshold(0.0)
    events = drive(seg, [speech_frame() for _ in range(5)])
    starts = [e for e in events if isinstance(e, SpeechStart)]
    assert len(starts) == 1


def test_set_threshold_clamps_to_one():
    cfg = VadConfig(threshold=0.5)
    seg = VadSegmenter(cfg, static_prob(0.99))
    seg.set_threshold(2.0)  # clamped to 1.0
    # 0.99 < 1.0 => no speech anymore
    events = drive(seg, [speech_frame() for _ in range(20)])
    assert events == []


# --- reset -----------------------------------------------------------------


def test_reset_drops_state():
    cfg = VadConfig(
        sample_rate=16000, frame_samples=480, threshold=0.5,
        min_speech_ms=100, min_silence_ms=400,
    )
    # Build state up: run-up halfway then reset, no event ever fires
    seg = VadSegmenter(cfg, stepwise_prob([0.9, 0.9]))
    drive(seg, [speech_frame() for _ in range(2)])
    seg.reset()
    # Continue with silence — no speech_start should appear
    events = drive(seg, [silence_frame() for _ in range(10)])
    assert events == []


# --- t_ms monotonicity ----------------------------------------------------


def test_t_ms_advances_per_frame():
    cfg = VadConfig(sample_rate=16000, frame_samples=480)
    seg = VadSegmenter(cfg, static_prob(0.0))
    drive(seg, [silence_frame() for _ in range(5)])
    assert seg.t_ms == 5 * 30


# --- segment duration ------------------------------------------------------


def test_segment_duration_excludes_silence_tail():
    """The `duration_ms` of the speech_end event should reflect speech
    time, NOT include the trailing min_silence run-down buffer."""
    cfg = VadConfig(
        sample_rate=16000, frame_samples=480, threshold=0.5,
        min_speech_ms=100, min_silence_ms=400,
    )
    # 20 frames speech (600ms), 20 frames silence (600ms)
    seg = VadSegmenter(
        cfg, stepwise_prob([0.9] * 20 + [0.0] * 20),
    )
    events = drive(seg, [speech_frame() for _ in range(40)])
    ends = [e for e in events if isinstance(e, SpeechEnd)]
    assert len(ends) == 1
    # Segment is 20 frames of speech => 600ms (start backdated to run-up
    # beginning). Tolerance of one frame for backdate boundary.
    assert 540 <= ends[0].duration_ms <= 660


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
