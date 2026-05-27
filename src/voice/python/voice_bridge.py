"""Symphony voice bridge — long-lived Python subprocess (Phase 6A).

Owns the microphone (or stdin PCM in test mode), runs Silero VAD on
fixed-size frames, and emits JSON events on stdout. Newline-delimited
JSON in both directions. See `src/voice/types.ts` for the wire format.

Commands (stdin):
    {"cmd":"shutdown"}
    {"cmd":"set_threshold","value":0.6}

Events (stdout):
    {"type":"ready", "backend":"...", "sampleRate":16000, ...}
    {"type":"speech_start", "tMs":...}
    {"type":"speech_end",   "tMs":..., "durationMs":...}
    {"type":"error",        "code":"...", "message":"..."}
    {"type":"shutdown_ack"}

stderr carries human-readable diagnostics (model load progress, audio
backend selection notices). Node prefixes every stderr line with
"[voice-bridge] " when relaying to its own stderr.

Exit codes:
    0 — clean shutdown (received shutdown command OR stdin EOF).
    1 — fatal init error (model load failed, no audio backend).
    2 — unexpected runtime error.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from typing import Iterator, Optional


# ---- relative import shim ------------------------------------------------
# The bridge can be launched via:
#   python -m src.voice.python.voice_bridge  (dev, from repo root)
#   python <abs>/dist/voice/python/voice_bridge.py  (built layout)
# When the parent dir isn't on sys.path the absolute imports fail; add
# our own dir as a fallback so the module imports work either way.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
if _THIS_DIR not in sys.path:
    sys.path.insert(0, _THIS_DIR)

from vad_segmenter import (  # type: ignore[import-not-found]
    SpeechEnd,
    SpeechStart,
    VadConfig,
    VadProbFn,
    VadSegmenter,
)


# ---- JSON event helpers --------------------------------------------------


def emit(event: dict) -> None:
    """Write one JSON event to stdout with a trailing newline + flush."""
    sys.stdout.write(json.dumps(event, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def emit_error(code: str, message: str) -> None:
    emit({"type": "error", "code": code, "message": message})


def log(msg: str) -> None:
    """Human-readable diagnostic to stderr. Bridge logs are noisy by
    design — the Node side prefixes and surfaces them."""
    sys.stderr.write(msg.rstrip() + "\n")
    sys.stderr.flush()


# ---- audio sources -------------------------------------------------------


def open_stdin_pcm(frame_samples: int) -> Iterator[bytes]:
    """Yield fixed-size frames from stdin (raw int16 LE mono PCM).

    Used by the diagnose CLI and integration tests so the bridge can be
    driven without a microphone. EOF on stdin ends the iterator —
    caller's main loop treats that as a clean shutdown.
    """
    frame_bytes = frame_samples * 2  # int16
    stdin_buf = sys.stdin.buffer
    while True:
        chunk = stdin_buf.read(frame_bytes)
        if not chunk:
            return
        if len(chunk) < frame_bytes:
            # Pad short trailing frame with zeros so the segmenter sees
            # a consistent shape. The padding is below threshold (= silence)
            # so it doesn't trip a spurious speech_start.
            chunk = chunk + b"\x00" * (frame_bytes - len(chunk))
        yield chunk


def open_mic(
    sample_rate: int, frame_samples: int, force_backend: Optional[str]
) -> tuple[Iterator[bytes], str, callable]:
    """Open the microphone via sounddevice (primary) or PyAudio (fallback).

    Returns ``(frame_iter, backend_name, close_fn)``.

    Strategy:
      - If ``force_backend`` is set, try only that one.
      - Otherwise, try sounddevice first (pure PyPI wheels on every OS).
      - On import / runtime failure, fall back to PyAudio.
      - If both fail, raise a single combined error.
    """
    last_err_sd: Optional[Exception] = None
    last_err_pa: Optional[Exception] = None

    backends_to_try = (
        [force_backend] if force_backend else ["sounddevice", "pyaudio"]
    )

    for backend in backends_to_try:
        if backend == "sounddevice":
            try:
                return _open_sounddevice(sample_rate, frame_samples)
            except Exception as e:  # pragma: no cover - hardware-dependent
                last_err_sd = e
                log(f"sounddevice init failed: {e!r}; trying fallback")
        elif backend == "pyaudio":
            try:
                return _open_pyaudio(sample_rate, frame_samples)
            except Exception as e:  # pragma: no cover
                last_err_pa = e
                log(f"pyaudio init failed: {e!r}")
        else:
            raise ValueError(f"unknown backend '{backend}'")

    raise RuntimeError(
        "no audio backend available — "
        f"sounddevice: {last_err_sd!r}; pyaudio: {last_err_pa!r}"
    )


def _open_sounddevice(  # pragma: no cover - hardware-dependent
    sample_rate: int, frame_samples: int
) -> tuple[Iterator[bytes], str, callable]:
    import sounddevice as sd  # type: ignore[import-not-found]
    import queue

    q: "queue.Queue[bytes]" = queue.Queue(maxsize=256)

    def _callback(indata, frames, time_info, status):  # noqa: ARG001
        if status:
            log(f"sounddevice status: {status}")
        # indata is int16, shape (frames, 1)
        q.put(bytes(indata))

    stream = sd.RawInputStream(
        samplerate=sample_rate,
        blocksize=frame_samples,
        dtype="int16",
        channels=1,
        callback=_callback,
    )
    stream.start()

    def _iter() -> Iterator[bytes]:
        while True:
            chunk = q.get()
            if chunk is None:
                return
            yield chunk

    def _close() -> None:
        try:
            stream.stop()
            stream.close()
        except Exception as e:
            log(f"sounddevice close failed: {e!r}")
        q.put(None)  # type: ignore[arg-type]

    return _iter(), "sounddevice", _close


def _open_pyaudio(  # pragma: no cover - hardware-dependent
    sample_rate: int, frame_samples: int
) -> tuple[Iterator[bytes], str, callable]:
    import pyaudio  # type: ignore[import-not-found]

    pa = pyaudio.PyAudio()
    stream = pa.open(
        format=pyaudio.paInt16,
        channels=1,
        rate=sample_rate,
        input=True,
        frames_per_buffer=frame_samples,
    )

    def _iter() -> Iterator[bytes]:
        while True:
            data = stream.read(frame_samples, exception_on_overflow=False)
            yield data

    def _close() -> None:
        try:
            stream.stop_stream()
            stream.close()
            pa.terminate()
        except Exception as e:
            log(f"pyaudio close failed: {e!r}")

    return _iter(), "pyaudio", _close


# ---- Silero VAD prob source ----------------------------------------------


def make_silero_prob_fn(sample_rate: int, frame_samples: int) -> VadProbFn:
    """Load Silero VAD's ONNX model and return a per-frame probability fn.

    Calls the ONNX session DIRECTLY rather than going through
    ``silero-vad``'s ``model(audio, sr)`` Python wrapper. The wrapper's
    inference path calls ``audio.dim()`` which only torch tensors have
    (verified on silero-vad 5.x + numpy). The direct path is the only
    torch-free option.

    Silero's ONNX expects each chunk to be prepended with a CONTEXT
    prefix of the last N samples of the previous chunk (N=64 for 16kHz,
    N=32 for 8kHz). Initial context is zeros. Skipping the context
    causes the model to output near-zero probability even on real
    speech (verified empirically; confirmed against the OnnxWrapper
    source in ``silero_vad/utils_vad.py``).

    Wire shape:
        input:  float32 (1, context_size + frame_samples)
        sr:     int64 scalar
        state:  float32 (2, 1, 128) — LSTM state, carried across calls
        output: float32 (1, 1) — speech probability
                + new state in output[1]
    """
    import numpy as np  # type: ignore[import-not-found]

    from silero_vad import load_silero_vad  # type: ignore[import-not-found]

    model = load_silero_vad(onnx=True)
    session = model.session

    # Persistent LSTM state across frames — the model is recurrent.
    state = np.zeros((2, 1, 128), dtype=np.float32)
    sr_np = np.array(sample_rate, dtype=np.int64)
    context_size = 64 if sample_rate == 16000 else 32
    # Sliding context: last `context_size` samples of the previous chunk.
    context = np.zeros((1, context_size), dtype=np.float32)

    def _prob(frame: bytes) -> float:
        nonlocal state, context
        # int16 LE mono -> float32 in [-1, 1]
        arr = (
            np.frombuffer(frame, dtype=np.int16).astype(np.float32) / 32768.0
        ).reshape(1, frame_samples)
        # Prepend context: combined shape (1, context_size + frame_samples)
        combined = np.concatenate([context, arr], axis=1)
        try:
            out = session.run(
                None,
                {"input": combined, "sr": sr_np, "state": state},
            )
            state = out[1]
            # Update context to last `context_size` samples of combined
            context = combined[:, -context_size:]
            return float(out[0][0][0])
        except Exception as e:
            log(f"silero prob failed on frame: {e!r}")
            return 0.0

    return _prob


# ---- main bridge loop ----------------------------------------------------


class Bridge:
    """The bridge's event loop. Keeps audio iter + segmenter + stdin
    reader in one object so threading lifetimes are obvious."""

    def __init__(
        self,
        input_mode: str,
        sample_rate: int,
        frame_samples: int,
        vad_threshold: float,
        vad_min_speech_ms: int,
        vad_min_silence_ms: int,
        force_backend: Optional[str],
    ) -> None:
        self.input_mode = input_mode
        self.cfg = VadConfig(
            sample_rate=sample_rate,
            frame_samples=frame_samples,
            threshold=vad_threshold,
            min_speech_ms=vad_min_speech_ms,
            min_silence_ms=vad_min_silence_ms,
        )
        self.force_backend = force_backend
        self.segmenter: Optional[VadSegmenter] = None
        self.audio_iter: Optional[Iterator[bytes]] = None
        self.audio_close: Optional[callable] = None
        self.backend_name = "stdin-pcm"
        self.shutdown_event = threading.Event()
        self._stdin_thread: Optional[threading.Thread] = None

    def init(self) -> None:
        """Load Silero, open audio source, emit ready."""
        log("loading Silero VAD model...")
        try:
            prob_fn = make_silero_prob_fn(
                self.cfg.sample_rate, self.cfg.frame_samples
            )
        except Exception as e:
            emit_error("silero-load-failed", repr(e))
            raise SystemExit(1) from e

        self.segmenter = VadSegmenter(self.cfg, prob_fn)

        log(f"opening audio source: {self.input_mode}")
        if self.input_mode == "stdin-pcm":
            self.audio_iter = open_stdin_pcm(self.cfg.frame_samples)
            self.backend_name = "stdin-pcm"
            self.audio_close = None
        elif self.input_mode == "mic":
            try:
                iterator, backend, close = open_mic(
                    self.cfg.sample_rate, self.cfg.frame_samples, self.force_backend
                )
            except Exception as e:
                emit_error("audio-init-failed", repr(e))
                raise SystemExit(1) from e
            self.audio_iter = iterator
            self.backend_name = backend
            self.audio_close = close
        else:
            emit_error("invalid-input-mode", f"unknown input-mode '{self.input_mode}'")
            raise SystemExit(1)

        emit(
            {
                "type": "ready",
                "backend": self.backend_name,
                "sampleRate": self.cfg.sample_rate,
                "vadThreshold": self.cfg.threshold,
                "vadMinSpeechMs": self.cfg.min_speech_ms,
                "vadMinSilenceMs": self.cfg.min_silence_ms,
            }
        )

    def _stdin_reader(self) -> None:
        """Read newline-delimited JSON commands from stdin.

        Runs on a daemon thread because reading stdin is blocking and
        we don't want to gate audio processing on it. Sets the shutdown
        event on EOF (stdin closed) OR explicit shutdown command.

        Note: this only fires for input_mode='mic'. In stdin-pcm mode
        stdin IS the audio source, so command-channel multiplexing is
        not supported (kept simple for 6A's diagnose flow).
        """
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError as e:
                    emit_error("invalid-command-json", str(e))
                    continue
                cmd = msg.get("cmd")
                if cmd == "shutdown":
                    self.shutdown_event.set()
                    return
                elif cmd == "set_threshold":
                    value = msg.get("value")
                    if isinstance(value, (int, float)) and self.segmenter is not None:
                        self.segmenter.set_threshold(float(value))
                    else:
                        emit_error(
                            "invalid-set-threshold",
                            f"value must be a number, got {value!r}",
                        )
                else:
                    emit_error("unknown-command", f"unknown cmd '{cmd}'")
        except Exception as e:  # pragma: no cover - rare stdin failure
            emit_error("stdin-reader-failed", repr(e))
            self.shutdown_event.set()

    def run(self) -> int:
        """Main loop. Returns the process exit code.

        Audit-m6 note: in mic mode the audio iterator's `q.get()`
        BLOCKS waiting for the next sounddevice callback. The
        `shutdown_event` flag is checked AFTER each frame returns —
        so the latency floor for honoring a shutdown command is one
        frame (~32 ms at 16 kHz / 512-sample chunks). In practice
        sounddevice keeps producing frames at the configured cadence
        even during silence; if a future audio backend can pause its
        callback stream, swap the queue's blocking `get()` to a
        `get(timeout=0.1)` + Empty-catch loop so the flag is polled
        at 10 Hz regardless of audio cadence.
        """
        assert self.segmenter is not None
        assert self.audio_iter is not None

        # Start stdin command reader for mic mode. In stdin-pcm mode
        # stdin IS the audio source — no separate command channel.
        if self.input_mode == "mic":
            self._stdin_thread = threading.Thread(
                target=self._stdin_reader, daemon=True, name="voice-stdin"
            )
            self._stdin_thread.start()

        try:
            for frame in self.audio_iter:
                if self.shutdown_event.is_set():
                    break
                try:
                    for event in self.segmenter.push(frame):
                        if isinstance(event, SpeechStart):
                            emit({"type": "speech_start", "tMs": event.t_ms})
                        elif isinstance(event, SpeechEnd):
                            emit(
                                {
                                    "type": "speech_end",
                                    "tMs": event.t_ms,
                                    "durationMs": event.duration_ms,
                                }
                            )
                except ValueError as e:
                    # Audit-m7 fix: fail-fast on first frame-shape error
                    # rather than flooding every subsequent frame with the
                    # same error. Frame-size mismatch is a configuration
                    # bug (Node/Python disagree on frame_samples) — keep-
                    # going just spammed N errors/sec while remaining broken.
                    emit_error("frame-shape", str(e))
                    log(f"frame-shape error: {e!r} — exiting; check --frame-samples alignment")
                    self.shutdown_event.set()
                    break
        finally:
            if self.audio_close is not None:
                self.audio_close()

        # If we exited the loop without a shutdown command, this is a
        # natural end-of-stream (stdin EOF in stdin-pcm mode). Emit ack
        # and exit cleanly.
        emit({"type": "shutdown_ack"})
        return 0


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Symphony voice bridge (Phase 6A)")
    p.add_argument(
        "--input-mode",
        choices=("mic", "stdin-pcm"),
        default="mic",
        help="Where to read PCM from (default: mic).",
    )
    p.add_argument("--sample-rate", type=int, default=16000)
    p.add_argument(
        "--frame-samples",
        type=int,
        default=512,
        help=(
            "Samples per frame. Silero v5 ONNX expects 512 at 16kHz "
            "(=32ms). 480 (30ms) works for the segmenter math but is "
            "not the model's preferred chunk size."
        ),
    )
    p.add_argument(
        "--vad-threshold",
        type=float,
        default=0.5,
        help="Silero probability above which a frame counts as speech.",
    )
    p.add_argument(
        "--vad-min-speech-ms",
        type=int,
        default=100,
        help="Speech run-up before emitting speech_start.",
    )
    p.add_argument(
        "--vad-min-silence-ms",
        type=int,
        default=400,
        help="Silence run-down before emitting speech_end.",
    )
    p.add_argument(
        "--force-backend",
        choices=("sounddevice", "pyaudio"),
        default=None,
        help="Force one audio backend (default: try sounddevice, fall back to pyaudio).",
    )
    return p.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    bridge = Bridge(
        input_mode=args.input_mode,
        sample_rate=args.sample_rate,
        frame_samples=args.frame_samples,
        vad_threshold=args.vad_threshold,
        vad_min_speech_ms=args.vad_min_speech_ms,
        vad_min_silence_ms=args.vad_min_silence_ms,
        force_backend=args.force_backend,
    )
    bridge.init()
    return bridge.run()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        # SIGINT from the parent process — Bridge.run() will have
        # already cleaned up via the iterator-close path. Exit clean.
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as e:
        emit_error("unhandled", repr(e))
        sys.exit(2)
