"""pytest suite for ``wake_word_detector.py``.

Pure-Python tests: openWakeWord's Model is replaced by an injected
``predict_fn`` callable so no .onnx loading is needed. Drives the
detector with deterministic synthetic frames + scripted score sequences.

Run via the voice venv's pytest:
    ~/.symphony/voice-env/bin/pytest tests/voice/python/

Phase 6C — wake-word detector. Covers:
  - Sustain logic (N consecutive above-threshold required to fire)
  - Cooldown logic (post-fire suppression window)
  - Ring buffer (multi-window accumulation, no leaks across windows)
  - Single below-threshold frame resets the sustain counter
  - `reset()` clears all state cleanly
  - Predict callable receives correct shape int16 ndarrays
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Add the python source dir so the test can `import wake_word_detector`
# without the bridge installer being run.
HERE = Path(__file__).resolve().parent
SRC_DIR = HERE.parents[2] / "src" / "voice" / "python"
sys.path.insert(0, str(SRC_DIR))

import pytest  # noqa: E402

from wake_word_detector import (  # noqa: E402
    WakeWordConfig,
    WakeWordDetector,
    WakeWordFire,
    WakeWordModelMissingError,
)


# --- helpers -------------------------------------------------------------


def silero_frame(frame_samples: int = 512) -> bytes:
    """Return one Silero-sized int16 frame (1024 bytes by default)."""
    return b"\x00\x00" * frame_samples


def scripted_predict(scores_sequence):
    """Build a predict_fn that returns scores from the sequence, one per call.

    Each entry can be either a float (single-model score) or a dict.
    After exhaustion returns score 0.0 (below threshold).
    """
    sequence_iter = iter(scores_sequence)

    def _predict(_audio):
        try:
            entry = next(sequence_iter)
        except StopIteration:
            return {"hey-symphony": 0.0}
        if isinstance(entry, dict):
            return entry
        return {"hey-symphony": float(entry)}

    return _predict


def constant_predict(score: float):
    """predict_fn that returns the same score on every call."""

    def _predict(_audio):
        return {"hey-symphony": float(score)}

    return _predict


def _push_n_silero_frames_for_one_window(detector: WakeWordDetector) -> WakeWordFire | None:
    """Push enough 512-sample frames to fill one 1280-sample window.

    1280 / 512 = 2.5, so we need 3 Silero frames (1536 samples) — the
    detector will consume 1280 samples and keep 256 in the buffer for
    next time.
    """
    fire = None
    for _ in range(3):
        result = detector.push(silero_frame())
        if result is not None:
            fire = result
    return fire


# --- fixtures ------------------------------------------------------------


@pytest.fixture
def default_config():
    return WakeWordConfig(
        sample_rate=16000,
        frame_samples=512,
        window_samples=1280,
        threshold=0.5,
        sustain_frames=3,
        cooldown_ms=2000,
        model_name="hey-symphony",
    )


# --- tests ---------------------------------------------------------------


def test_below_threshold_never_fires(default_config):
    """Constant low scores must NEVER trigger a fire."""
    detector = WakeWordDetector(
        default_config, model_path="<test>", predict_fn=constant_predict(0.2),
    )
    for _ in range(20):
        result = detector.push(silero_frame())
        assert result is None


def test_single_above_threshold_does_not_fire(default_config):
    """A single above-threshold prediction is not enough (sustain_frames=3)."""
    # One window above threshold, then drop.
    predict_fn = scripted_predict([0.9, 0.1, 0.1, 0.1])
    detector = WakeWordDetector(
        default_config, model_path="<test>", predict_fn=predict_fn,
    )
    # Push enough frames to span 4 windows (~4 * 80 ms = 320 ms)
    fire = None
    for _ in range(12):
        result = detector.push(silero_frame())
        if result is not None:
            fire = result
    assert fire is None


def test_sustained_above_threshold_fires(default_config):
    """3 consecutive above-threshold predictions trigger a fire."""
    predict_fn = constant_predict(0.85)
    detector = WakeWordDetector(
        default_config, model_path="<test>", predict_fn=predict_fn,
    )
    # Need ≥3 windows (each window = 3 Silero frames except for the first
    # which needs the full 1280 → 1280 = 2.5 * 512). Push 9 frames to
    # guarantee 3 full windows of prediction.
    fire = None
    for _ in range(15):
        result = detector.push(silero_frame())
        if result is not None:
            fire = result
            break
    assert fire is not None
    assert fire.model == "hey-symphony"
    assert fire.score == pytest.approx(0.85)
    assert fire.t_ms > 0


def test_below_threshold_resets_sustain_counter(default_config):
    """A below-threshold frame between hits resets consecutive_hits."""
    # 2 hits, then a miss, then 2 hits → should NOT fire (sustain needs 3 in a row).
    predict_fn = scripted_predict([0.9, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9, 0.9, 0.1])
    detector = WakeWordDetector(
        default_config, model_path="<test>", predict_fn=predict_fn,
    )
    fire = None
    for _ in range(30):
        result = detector.push(silero_frame())
        if result is not None:
            fire = result
            break
    assert fire is None
    # The detector's internal counter should reset on each miss
    assert detector.consecutive_hits <= 2


def test_cooldown_suppresses_immediate_refire(default_config):
    """After a fire, additional above-threshold frames don't immediately re-fire."""
    predict_fn = constant_predict(0.9)
    detector = WakeWordDetector(
        default_config, model_path="<test>", predict_fn=predict_fn,
    )
    # First fire (after sustain)
    fire_1 = None
    for _ in range(15):
        result = detector.push(silero_frame())
        if result is not None:
            fire_1 = result
            break
    assert fire_1 is not None
    assert detector.in_cooldown

    # Push many more frames during cooldown — none should fire
    fire_2 = None
    for _ in range(20):
        result = detector.push(silero_frame())
        if result is not None:
            fire_2 = result
            break
    assert fire_2 is None
    assert detector.in_cooldown


def test_cooldown_expires_then_can_fire_again(default_config):
    """Once cooldown elapses, a new fire is possible."""
    # cooldown_ms=2000, frame_ms=32 → need ~62 silent frames to clear cooldown.
    cfg = WakeWordConfig(
        sample_rate=16000,
        frame_samples=512,
        window_samples=1280,
        threshold=0.5,
        sustain_frames=3,
        cooldown_ms=200,  # shorter cooldown for the test
        model_name="hey-symphony",
    )
    predict_fn = constant_predict(0.9)
    detector = WakeWordDetector(cfg, model_path="<test>", predict_fn=predict_fn)

    # First fire
    fire_1 = None
    for _ in range(15):
        result = detector.push(silero_frame())
        if result is not None:
            fire_1 = result
            break
    assert fire_1 is not None
    cooldown_t_at_first = detector.t_ms

    # Push silent frames until cooldown expires (200 ms / 32 ms/frame ≈ 7 frames)
    while detector.in_cooldown:
        detector.push(silero_frame())

    # Now able to fire again
    fire_2 = None
    for _ in range(15):
        result = detector.push(silero_frame())
        if result is not None:
            fire_2 = result
            break
    assert fire_2 is not None
    assert fire_2.t_ms > cooldown_t_at_first


def test_reset_clears_state(default_config):
    """reset() zeros t_ms, buffer, sustain counter, cooldown."""
    predict_fn = constant_predict(0.9)
    detector = WakeWordDetector(
        default_config, model_path="<test>", predict_fn=predict_fn,
    )
    for _ in range(15):
        detector.push(silero_frame())
    # Detector should have advanced + maybe fired
    assert detector.t_ms > 0

    detector.reset()
    assert detector.t_ms == 0
    assert detector.consecutive_hits == 0
    assert not detector.in_cooldown


def test_predict_fn_receives_correct_int16_shape(default_config):
    """The predict callable gets a numpy int16 array of window_samples length."""
    received = []

    def _spy(audio):
        received.append(audio)
        return {"hey-symphony": 0.0}

    detector = WakeWordDetector(
        default_config, model_path="<test>", predict_fn=_spy,
    )
    # Push enough frames to trigger ≥2 windows
    for _ in range(7):
        detector.push(silero_frame())

    assert len(received) >= 2
    import numpy as np  # type: ignore[import-not-found]

    for audio in received:
        assert isinstance(audio, np.ndarray)
        assert audio.dtype == np.int16
        assert audio.shape == (default_config.window_samples,)


def test_t_ms_monotonic_across_frames(default_config):
    """t_ms advances by frame_ms on every push, including buffered-only pushes."""
    predict_fn = constant_predict(0.1)
    detector = WakeWordDetector(
        default_config, model_path="<test>", predict_fn=predict_fn,
    )
    # frame_samples=512 at 16kHz → frame_ms = 32
    expected_t_ms = 0
    for i in range(10):
        detector.push(silero_frame())
        expected_t_ms += 32
        assert detector.t_ms == expected_t_ms


def test_model_missing_raises_at_construction(tmp_path, default_config):
    """Bad model path fails loud at __init__, not at first frame."""
    bogus = tmp_path / "nope.onnx"
    with pytest.raises(WakeWordModelMissingError) as exc:
        WakeWordDetector(default_config, model_path=str(bogus))
    assert "not found" in str(exc.value)


def test_multiple_windows_in_one_push_processed(default_config):
    """If push gives enough bytes for 2 windows, both get predicted."""
    received = []

    def _spy(audio):
        received.append(audio)
        return {"hey-symphony": 0.0}

    detector = WakeWordDetector(
        default_config, model_path="<test>", predict_fn=_spy,
    )
    # One mega-frame containing 2 full windows worth of audio (2560 samples).
    mega_frame = b"\x00\x00" * 2560
    detector.push(mega_frame)
    assert len(received) == 2


def test_score_in_fire_matches_predict_score(default_config):
    """The score field on the fired event matches the predict_fn's output."""
    predict_fn = constant_predict(0.73)
    detector = WakeWordDetector(
        default_config, model_path="<test>", predict_fn=predict_fn,
    )
    fire = None
    for _ in range(15):
        result = detector.push(silero_frame())
        if result is not None:
            fire = result
            break
    assert fire is not None
    assert fire.score == pytest.approx(0.73)


def test_multi_model_predict_picks_highest_score(default_config):
    """When predict_fn returns multiple keys, the highest score wins."""
    predict_fn = scripted_predict([
        {"hey-symphony": 0.7, "alexa": 0.95, "hey-jarvis": 0.3},
        {"hey-symphony": 0.7, "alexa": 0.95, "hey-jarvis": 0.3},
        {"hey-symphony": 0.7, "alexa": 0.95, "hey-jarvis": 0.3},
    ])
    detector = WakeWordDetector(
        default_config, model_path="<test>", predict_fn=predict_fn,
    )
    fire = None
    for _ in range(15):
        result = detector.push(silero_frame())
        if result is not None:
            fire = result
            break
    assert fire is not None
    # Symphony surfaces the configured model_name, NOT the actual key —
    # this is a deliberate UX simplification (we ship one wake-word).
    assert fire.model == "hey-symphony"
    assert fire.score == pytest.approx(0.95)
