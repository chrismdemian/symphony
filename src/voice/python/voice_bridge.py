"""Symphony voice bridge — long-lived Python subprocess.

Phase 6A introduced this bridge: Silero VAD on every frame, emitting
``speech_start`` / ``speech_end`` events on stdout. Phase 6B layers STT
on top: between ``speech_start`` and ``speech_end``, frames accumulate
into a per-segment buffer; a worker thread runs Moonshine inference on
snapshots at a configurable cadence (``--partial-interval-ms``) and on
the segment-end flush. Hard cap on utterance length (``--max-utterance-
seconds``) emits a ``warning`` and force-flushes the buffer. Phase 6C
adds wake-word detection: each frame also feeds an openWakeWord-backed
``WakeWordDetector`` (sustain + cooldown logic) which emits ``wake_word``
events on detection. Wake-word is opt-in via ``--wakeword-enabled``.

Commands (stdin):
    {"cmd":"shutdown"}
    {"cmd":"set_threshold","value":0.6}

Events (stdout):
    {"type":"ready", "backend":"...", "sampleRate":16000, ...}
    {"type":"stt_ready", "model":"moonshine/base"}   # Phase 6B
    {"type":"speech_start", "tMs":...}
    {"type":"speech_end",   "tMs":..., "durationMs":...}
    {"type":"partial",      "seq":N, "text":"...", "tMs":...}    # Phase 6B
    {"type":"final",        "seq":N, "text":"...", "tMs":..., "durationMs":...}  # Phase 6B
    {"type":"warning",      "code":"utterance-truncated", "tMs":...}  # Phase 6B
    {"type":"wake_word",    "model":"hey-symphony", "score":0.83, "tMs":...}  # Phase 6C
    {"type":"error",        "code":"...", "message":"..."}
    {"type":"shutdown_ack"}

Threading (Phase 6B):
  - Main thread: audio iter -> VAD -> emits speech_start/end + warning.
  - STT worker thread: loads Moonshine on start, runs warmup inference,
    emits ``stt_ready``; then dequeues partial/final requests and emits.
    Finals are priority + never dropped; partials are drop-oldest (only
    the latest pending partial is processed when the worker frees up).
  - Stdin command reader thread (mic mode only): unchanged from 6A.
  - All stdout emits route through an emit-lock so JSON lines stay
    atomic across threads.

stderr carries human-readable diagnostics (model load progress, audio
backend selection, vocab load stats). Node prefixes every stderr line
with ``[voice-bridge] `` when relaying.

Exit codes:
    0 - clean shutdown (received shutdown command OR stdin EOF).
    1 - fatal init error (model load failed, no audio backend).
    2 - unexpected runtime error.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import queue
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

# Phase 6B: stdout writes happen from BOTH the main thread (VAD events)
# AND the STT worker thread (transcription events). Without serialization,
# JSON lines can interleave at the byte level under contention. The
# emit-lock guarantees one JSON-line-per-write atomicity.
_EMIT_LOCK = threading.Lock()


def emit(event: dict) -> None:
    """Write one JSON event to stdout with a trailing newline + flush.

    Thread-safe across the main thread + STT worker thread (Phase 6B).
    """
    payload = json.dumps(event, separators=(",", ":"))
    with _EMIT_LOCK:
        sys.stdout.write(payload)
        sys.stdout.write("\n")
        sys.stdout.flush()


def emit_error(code: str, message: str) -> None:
    emit({"type": "error", "code": code, "message": message})


def log(msg: str) -> None:
    """Human-readable diagnostic to stderr. Bridge logs are noisy by
    design - the Node side prefixes and surfaces them."""
    sys.stderr.write(msg.rstrip() + "\n")
    sys.stderr.flush()


# ---- audio sources -------------------------------------------------------


def open_stdin_pcm(frame_samples: int) -> Iterator[bytes]:
    """Yield fixed-size frames from stdin (raw int16 LE mono PCM).

    Used by the diagnose CLI and integration tests so the bridge can be
    driven without a microphone. EOF on stdin ends the iterator -
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
        "no audio backend available - "
        f"sounddevice: {last_err_sd!r}; pyaudio: {last_err_pa!r}"
    )


def _open_sounddevice(  # pragma: no cover - hardware-dependent
    sample_rate: int, frame_samples: int
) -> tuple[Iterator[bytes], str, callable]:
    import sounddevice as sd  # type: ignore[import-not-found]
    import queue as _q

    q: "_q.Queue[bytes]" = _q.Queue(maxsize=256)

    def _callback(indata, frames, time_info, status):  # noqa: ARG001
        if status:
            log(f"sounddevice status: {status}")
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
        state:  float32 (2, 1, 128) - LSTM state, carried across calls
        output: float32 (1, 1) - speech probability
                + new state in output[1]
    """
    import numpy as np  # type: ignore[import-not-found]

    from silero_vad import load_silero_vad  # type: ignore[import-not-found]

    model = load_silero_vad(onnx=True)
    session = model.session

    # Persistent LSTM state across frames - the model is recurrent.
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


# ---- STT worker thread (Phase 6B) ----------------------------------------


class SttWorker:
    """Background thread that runs Moonshine inference.

    Owns a ``MoonshineTranscriber`` instance, a vocab ``Substituter``,
    and two pending-work slots:
      - ``_pending_partial``: single slot. Drop-oldest semantics — only
        the latest partial enqueued before the worker frees up survives.
        Partials are inherently disposable; only freshness matters.
      - ``_pending_finals``: unbounded list. Finals are never dropped.

    Construct, call ``start()``, then ``enqueue_partial`` /
    ``enqueue_final`` from the main thread. Call ``stop()`` to drain
    pending work + join the thread.

    Load + warmup happens lazily on the worker thread itself:
      1. Import ``moonshine_onnx`` + load the model.
      2. Run a 1-second silence inference to warm numba JIT.
      3. Emit ``stt_ready`` event.
      4. Begin processing the pending-work slots.

    If load OR warmup fails, the worker emits an ``error`` event with
    code ``stt-load-failed`` and disables itself — subsequent enqueues
    are silently dropped. The bridge still emits VAD events; STT is
    degraded gracefully.
    """

    def __init__(
        self,
        model: str,
        vocab_sub,
        sample_rate: int,
        shutdown_event: threading.Event,
    ) -> None:
        self._model = model
        self._vocab = vocab_sub
        self._sample_rate = sample_rate
        self._shutdown_event = shutdown_event
        self._lock = threading.Lock()
        # _pending_partial: tuple (seq, pcm_bytes, t_ms) or None.
        self._pending_partial: Optional[tuple[int, bytes, int]] = None
        # _pending_finals: list[(seq, pcm_bytes, t_ms, duration_ms)].
        self._pending_finals: list[tuple[int, bytes, int, int]] = []
        self._wake = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._disabled = False
        # `_ready` flips True once the warmup completes and `stt_ready`
        # has been emitted. Used only for diagnostics / tests; the
        # enqueue path doesn't gate on it (partials/finals enqueued
        # before ready will simply process AFTER load+warmup).
        self._ready = False

    @property
    def is_ready(self) -> bool:
        return self._ready

    @property
    def is_disabled(self) -> bool:
        return self._disabled

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="stt-worker",
        )
        self._thread.start()

    def enqueue_partial(self, seq: int, pcm: bytes, t_ms: int) -> None:
        """Replace any pending partial with the latest one.

        Drop-oldest semantics — the previous pending partial (if any)
        is discarded. Cheap; sub-microsecond. Safe to call from the
        main thread.
        """
        if self._disabled or self._shutdown_event.is_set():
            return
        with self._lock:
            self._pending_partial = (seq, pcm, t_ms)
        self._wake.set()

    def enqueue_final(
        self, seq: int, pcm: bytes, t_ms: int, duration_ms: int,
    ) -> None:
        """Enqueue a final inference request. Never dropped."""
        if self._disabled or self._shutdown_event.is_set():
            return
        with self._lock:
            self._pending_finals.append((seq, pcm, t_ms, duration_ms))
        self._wake.set()

    def stop(self, timeout: float = 30.0) -> None:
        """Signal stop and join the worker thread.

        The worker drains pending finals + the latest pending partial
        BEFORE exiting (so a `speech_end` immediately followed by EOF
        still produces a `final` event). Bounded by ``timeout`` to
        protect against a wedged inference call.
        """
        self._shutdown_event.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)

    def _run(self) -> None:
        try:
            self._load_and_warmup()
        except Exception as e:  # noqa: BLE001
            # Load failure is non-fatal to the bridge - VAD continues
            # without STT. Emit an error event so consumers know STT
            # never came online; flag disabled so further enqueues no-op.
            emit_error("stt-load-failed", f"{type(e).__name__}: {e!r}")
            self._disabled = True
            return
        self._loop()

    def _load_and_warmup(self) -> None:
        # Import lazily — the worker thread is the only place we touch
        # moonshine_onnx; bridge.init() doesn't import it.
        from stt_moonshine import MoonshineTranscriber  # type: ignore[import-not-found]

        log(f"loading Moonshine STT model: {self._model}...")
        self._transcriber = MoonshineTranscriber(self._model)
        self._transcriber.load()
        log("running Moonshine numba JIT warmup (1s silence)...")
        self._transcriber.warmup()
        emit({"type": "stt_ready", "model": self._model})
        self._ready = True

    def _loop(self) -> None:
        from stt_moonshine import int16_pcm_to_float32  # type: ignore[import-not-found]

        while True:
            # Drain finals first (priority)
            while True:
                with self._lock:
                    if not self._pending_finals:
                        break
                    item = self._pending_finals.pop(0)
                seq, pcm, t_ms, duration_ms = item
                self._process(int16_pcm_to_float32, "final", seq, pcm, t_ms, duration_ms)
            # Process at most one pending partial
            with self._lock:
                partial = self._pending_partial
                self._pending_partial = None
            if partial is not None:
                seq, pcm, t_ms = partial
                self._process(int16_pcm_to_float32, "partial", seq, pcm, t_ms, None)
            # Exit when shutdown is set AND nothing more to do.
            if self._shutdown_event.is_set():
                with self._lock:
                    nothing_left = (
                        self._pending_partial is None
                        and len(self._pending_finals) == 0
                    )
                if nothing_left:
                    return
            # Wait for next signal or timeout (10 Hz idle poll keeps us
            # responsive to shutdown without busy-looping).
            self._wake.wait(timeout=0.1)
            self._wake.clear()

    def _process(
        self,
        pcm_to_float,
        kind: str,
        seq: int,
        pcm: bytes,
        t_ms: int,
        duration_ms: Optional[int],
    ) -> None:
        audio_f32 = pcm_to_float(pcm)
        if audio_f32.size == 0:
            text = ""
        else:
            try:
                raw = self._transcriber.transcribe(audio_f32)
            except Exception as e:  # noqa: BLE001
                emit_error(
                    "stt-transcribe-failed",
                    f"{kind} seq={seq}: {type(e).__name__}: {e!r}",
                )
                return
            text = self._vocab.apply(raw) if self._vocab is not None else raw
        if kind == "partial":
            emit({"type": "partial", "seq": seq, "text": text, "tMs": t_ms})
        else:
            emit({
                "type": "final",
                "seq": seq,
                "text": text,
                "tMs": t_ms,
                "durationMs": duration_ms if duration_ms is not None else 0,
            })


# ---- main bridge loop ----------------------------------------------------


class Bridge:
    """The bridge's event loop. Keeps audio iter + segmenter + stdin
    reader + STT worker in one object so threading lifetimes are obvious."""

    def __init__(
        self,
        input_mode: str,
        sample_rate: int,
        frame_samples: int,
        vad_threshold: float,
        vad_min_speech_ms: int,
        vad_min_silence_ms: int,
        force_backend: Optional[str],
        stt_enabled: bool,
        stt_model: str,
        max_utterance_seconds: int,
        partial_interval_ms: int,
        stt_vocab_paths: list[str],
        wakeword_enabled: bool = False,
        wakeword_model_path: Optional[str] = None,
        wakeword_model_name: str = "hey-symphony",
        wakeword_threshold: float = 0.5,
        wakeword_sustain_frames: int = 3,
        wakeword_cooldown_ms: int = 2000,
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
        # Phase 6B fields
        self.stt_enabled = stt_enabled
        self.stt_model = stt_model
        self.max_utterance_seconds = max_utterance_seconds
        self.partial_interval_ms = partial_interval_ms
        self.stt_vocab_paths = stt_vocab_paths
        self.stt_worker: Optional[SttWorker] = None
        # Phase 6C fields
        self.wakeword_enabled = wakeword_enabled
        self.wakeword_model_path = wakeword_model_path
        self.wakeword_model_name = wakeword_model_name
        self.wakeword_threshold = wakeword_threshold
        self.wakeword_sustain_frames = wakeword_sustain_frames
        self.wakeword_cooldown_ms = wakeword_cooldown_ms
        self.wake_detector = None  # Optional["WakeWordDetector"], lazy-imported in init()
        # Per-segment state
        self.in_segment = False
        self.segment_buffer = bytearray()
        self.partial_seq = 0
        self.last_partial_t_ms = 0
        # Pre-roll ring buffer — holds the most recent N frames so we
        # can prepend them to the segment buffer at speech_start. Without
        # this, the first `min_speech_ms` of audio is lost (the run-up
        # frames that triggered the segmenter). Sized to cover at least
        # the run-up window + a small safety margin.
        preroll_frames = max(1, (self.cfg.min_speech_ms + 30) // self._frame_ms())
        self.preroll: collections.deque[bytes] = collections.deque(
            maxlen=preroll_frames,
        )

    def _frame_ms(self) -> int:
        return self.cfg.frame_samples * 1000 // self.cfg.sample_rate

    def init(self) -> None:
        """Load Silero, open audio source, emit ready. Kick off STT worker."""
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

        # Phase 6C: instantiate wake-word detector synchronously on the
        # main thread. openWakeWord cold-start is ~50 ms (ONNX session +
        # frozen embedding backbone) — fast enough to block the main thread
        # without delaying `ready` perceptibly. If the model is missing or
        # openwakeword isn't installed, surface an error event but keep
        # VAD/STT alive (degraded mode).
        if self.wakeword_enabled:
            if not self.wakeword_model_path:
                emit_error(
                    "wake-word-config-invalid",
                    "wakeword_enabled but no model path provided",
                )
            else:
                try:
                    from wake_word_detector import (  # type: ignore[import-not-found]
                        WakeWordConfig,
                        WakeWordDetector,
                    )

                    wake_cfg = WakeWordConfig(
                        sample_rate=self.cfg.sample_rate,
                        frame_samples=self.cfg.frame_samples,
                        threshold=self.wakeword_threshold,
                        sustain_frames=self.wakeword_sustain_frames,
                        cooldown_ms=self.wakeword_cooldown_ms,
                        model_name=self.wakeword_model_name,
                    )
                    log(
                        f"loading wake-word model: {self.wakeword_model_name} "
                        f"from {self.wakeword_model_path}..."
                    )
                    self.wake_detector = WakeWordDetector(
                        wake_cfg, self.wakeword_model_path,
                    )
                    log("wake-word detector ready.")
                except Exception as e:  # noqa: BLE001
                    emit_error(
                        "wake-word-load-failed",
                        f"{type(e).__name__}: {e!r}",
                    )
                    self.wake_detector = None

        # Phase 6B: kick off STT worker. Load + warmup happens on the
        # worker thread; `stt_ready` fires once warmup completes. While
        # this is in flight, VAD events still emit normally.
        if self.stt_enabled:
            from voice_vocab import load_vocab  # type: ignore[import-not-found]

            vocab_sub, vocab_stats = load_vocab(self.stt_vocab_paths)
            loaded_count = sum(s.entry_count for s in vocab_stats if s.loaded)
            if loaded_count > 0:
                log(
                    f"loaded {loaded_count} vocab substitution(s) from "
                    f"{sum(1 for s in vocab_stats if s.loaded)} file(s)"
                )
            self.stt_worker = SttWorker(
                model=self.stt_model,
                vocab_sub=vocab_sub,
                sample_rate=self.cfg.sample_rate,
                shutdown_event=self.shutdown_event,
            )
            self.stt_worker.start()
        else:
            log("STT disabled (--no-stt) - VAD-only mode")

    def _stdin_reader(self) -> None:
        """Read newline-delimited JSON commands from stdin (mic mode only).

        Runs on a daemon thread because reading stdin is blocking and
        we don't want to gate audio processing on it. Sets the shutdown
        event on EOF (stdin closed) OR explicit shutdown command.
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
                    # VAD threshold (Silero). Distinct from the wake-word
                    # threshold (audit-M2) — the two are separate knobs.
                    value = msg.get("value")
                    if isinstance(value, (int, float)) and self.segmenter is not None:
                        self.segmenter.set_threshold(float(value))
                    else:
                        emit_error(
                            "invalid-set-threshold",
                            f"value must be a number, got {value!r}",
                        )
                elif cmd == "set_wake_threshold":
                    # Phase 6C (audit-M2) — wake-word threshold. Silently a
                    # no-op when wake-word isn't enabled, but we surface a
                    # warning so a 6E settings popup knows the knob landed
                    # nowhere rather than mysteriously not working.
                    value = msg.get("value")
                    if not isinstance(value, (int, float)):
                        emit_error(
                            "invalid-set-wake-threshold",
                            f"value must be a number, got {value!r}",
                        )
                    elif self.wake_detector is None:
                        emit({
                            "type": "warning",
                            "code": "wake-word-disabled",
                            "tMs": self.segmenter.t_ms if self.segmenter else 0,
                        })
                    else:
                        self.wake_detector.set_threshold(float(value))
                else:
                    emit_error("unknown-command", f"unknown cmd '{cmd}'")
        except Exception as e:  # pragma: no cover - rare stdin failure
            emit_error("stdin-reader-failed", repr(e))
            self.shutdown_event.set()

    def run(self) -> int:
        """Main loop. Returns the process exit code."""
        assert self.segmenter is not None
        assert self.audio_iter is not None

        # Start stdin command reader for mic mode. In stdin-pcm mode
        # stdin IS the audio source - no separate command channel.
        if self.input_mode == "mic":
            self._stdin_thread = threading.Thread(
                target=self._stdin_reader, daemon=True, name="voice-stdin",
            )
            self._stdin_thread.start()

        try:
            for frame in self.audio_iter:
                if self.shutdown_event.is_set():
                    break
                # Pre-roll ring buffer: always append the LATEST frame
                # so on speech_start we can backfill the run-up audio
                # that triggered the segmenter.
                self.preroll.append(frame)
                try:
                    events = list(self.segmenter.push(frame))
                except ValueError as e:
                    # Fail-fast on first frame-shape error rather than
                    # flooding subsequent frames with the same error.
                    emit_error("frame-shape", str(e))
                    log(
                        f"frame-shape error: {e!r} - exiting; check --frame-samples alignment"
                    )
                    self.shutdown_event.set()
                    break
                # Phase 6C — feed the same frame into the wake-word
                # detector. Runs independently of VAD; fires whenever the
                # sustain + cooldown logic commits. Bounded cost (~1 ms
                # per 80 ms window on CPU), safely within the 32 ms frame
                # budget.
                if self.wake_detector is not None:
                    try:
                        # Audit-M1: pass the segmenter's clock so wake_word
                        # tMs lives on the SAME timeline as speech_start /
                        # speech_end (both "ms since ready"). segmenter.push
                        # above already advanced this for the current frame.
                        fire = self.wake_detector.push(
                            frame, t_ms=self.segmenter.t_ms,
                        )
                    except Exception as e:  # noqa: BLE001
                        emit_error(
                            "wake-word-predict-failed",
                            f"{type(e).__name__}: {e!r}",
                        )
                        self.wake_detector = None
                        fire = None
                    if fire is not None:
                        emit({
                            "type": "wake_word",
                            "model": fire.model,
                            "score": float(fire.score),
                            "tMs": fire.t_ms,
                        })

                # Process VAD events (these affect in_segment state)
                started_this_frame = False
                for event in events:
                    if isinstance(event, SpeechStart):
                        emit({"type": "speech_start", "tMs": event.t_ms})
                        self._on_speech_start(event)
                        started_this_frame = True
                    elif isinstance(event, SpeechEnd):
                        self._on_speech_end(event)
                # Mid-segment frame accumulation. We avoid duplicating
                # the current frame: when started_this_frame is True,
                # _on_speech_start already pulled the trigger frame
                # out of the preroll ring (it's the last entry).
                if self.in_segment and not started_this_frame:
                    self._on_mid_segment_frame(frame)
        finally:
            # Flush any in-flight segment so a clean stdin EOF mid-utterance
            # still produces a final event.
            if self.in_segment and len(self.segment_buffer) > 0:
                self._flush_open_segment()
            # Stop STT worker (drains pending finals + latest partial,
            # then exits).
            if self.stt_worker is not None:
                self.stt_worker.stop()
            if self.audio_close is not None:
                self.audio_close()

        # Emit shutdown_ack AFTER the worker has drained, guaranteeing
        # any pending final event lands BEFORE the ack.
        emit({"type": "shutdown_ack"})
        return 0

    def _on_speech_start(self, event: SpeechStart) -> None:
        """Initialize per-segment state. Pre-fill segment_buffer from preroll.

        The preroll deque already contains the trigger frame (we append
        it before calling segmenter.push). To avoid duplicating it when
        the main loop appends the trigger frame after this returns, we
        include ALL preroll frames here EXCEPT the last one. The caller
        then appends the trigger frame via the normal mid-segment path,
        wait no — actually the main loop tracks `started_this_frame`
        and SKIPS the normal append for the trigger frame, so we
        include the full preroll here.

        Why: the trigger frame's contribution belongs at the END of the
        run-up audio chronologically. The preroll deque already has it
        as the most recent entry. Copying the full deque preserves the
        natural order: run-up frames + trigger frame -> mid-segment frames.
        """
        self.in_segment = True
        self.partial_seq = 0
        self.last_partial_t_ms = event.t_ms
        self.segment_buffer = bytearray()
        for f in self.preroll:
            self.segment_buffer.extend(f)

    def _on_speech_end(self, event: SpeechEnd) -> None:
        emit(
            {
                "type": "speech_end",
                "tMs": event.t_ms,
                "durationMs": event.duration_ms,
            }
        )
        if self.stt_worker is not None and len(self.segment_buffer) > 0:
            self.partial_seq += 1
            self.stt_worker.enqueue_final(
                seq=self.partial_seq,
                pcm=bytes(self.segment_buffer),
                t_ms=event.t_ms,
                duration_ms=event.duration_ms,
            )
        self.in_segment = False
        self.segment_buffer = bytearray()

    def _on_mid_segment_frame(self, frame: bytes) -> None:
        """Append frame to segment buffer; check hard-cap + partial cadence."""
        self.segment_buffer.extend(frame)
        assert self.segmenter is not None
        # Hard-cap check
        audio_ms = (len(self.segment_buffer) // 2) * 1000 // self.cfg.sample_rate
        if audio_ms >= self.max_utterance_seconds * 1000:
            self._force_flush_hard_cap(audio_ms)
            return
        # Partial-cadence check
        if (self.segmenter.t_ms - self.last_partial_t_ms) >= self.partial_interval_ms:
            self.last_partial_t_ms = self.segmenter.t_ms
            if self.stt_worker is not None:
                self.partial_seq += 1
                self.stt_worker.enqueue_partial(
                    seq=self.partial_seq,
                    pcm=bytes(self.segment_buffer),
                    t_ms=self.segmenter.t_ms,
                )

    def _force_flush_hard_cap(self, audio_ms: int) -> None:
        """Emit warning BEFORE final inference round-trip.

        Ordering is timing-sensitive UX: the warning fires AT the
        truncation moment so the TUI can show "(cut at Ns)" within the
        same frame, not 0.5s later when the final inference completes.
        """
        assert self.segmenter is not None
        end_t = self.segmenter.t_ms
        emit({"type": "warning", "code": "utterance-truncated", "tMs": end_t})
        emit({"type": "speech_end", "tMs": end_t, "durationMs": audio_ms})
        if self.stt_worker is not None:
            self.partial_seq += 1
            self.stt_worker.enqueue_final(
                seq=self.partial_seq,
                pcm=bytes(self.segment_buffer),
                t_ms=end_t,
                duration_ms=audio_ms,
            )
        # Reset PER-SEGMENT state so the next frame starts a fresh
        # segment. Critically use `reset_segment_only` (audit-M1) — the
        # full `reset()` would rewind the monotonic `_t_ms` timeline
        # to zero, violating the "tMs is milliseconds since ready"
        # wire contract documented in src/voice/types.ts.
        self.segmenter.reset_segment_only()
        self.in_segment = False
        self.segment_buffer = bytearray()

    def _flush_open_segment(self) -> None:
        """On clean shutdown mid-segment, emit speech_end + final.

        Better than losing the partial utterance. Called from `run()`'s
        finally clause when `in_segment` is still True at EOF.
        """
        assert self.segmenter is not None
        audio_ms = (len(self.segment_buffer) // 2) * 1000 // self.cfg.sample_rate
        end_t = self.segmenter.t_ms
        emit({"type": "speech_end", "tMs": end_t, "durationMs": audio_ms})
        if self.stt_worker is not None:
            self.partial_seq += 1
            self.stt_worker.enqueue_final(
                seq=self.partial_seq,
                pcm=bytes(self.segment_buffer),
                t_ms=end_t,
                duration_ms=audio_ms,
            )
        self.in_segment = False
        self.segment_buffer = bytearray()


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Symphony voice bridge (Phase 6A/6B)")
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
    # Phase 6B flags
    p.add_argument(
        "--no-stt",
        action="store_true",
        help="Disable STT layer (VAD-only mode, 6A behavior).",
    )
    p.add_argument(
        "--stt-model",
        choices=("moonshine/base", "moonshine/tiny"),
        default="moonshine/base",
        help="Moonshine model id (default: moonshine/base).",
    )
    p.add_argument(
        "--max-utterance-seconds",
        type=int,
        default=30,
        help="Hard cap on utterance length; force-flush on cap (default: 30).",
    )
    p.add_argument(
        "--partial-interval-ms",
        type=int,
        default=200,
        help="Cadence for partial transcription events while recording (default: 200).",
    )
    p.add_argument(
        "--stt-vocab-path",
        dest="stt_vocab_paths",
        action="append",
        default=[],
        help=(
            "Path to a vocab substitution JSON file. Repeatable; layers "
            "merge in order (later wins on key collision). Defaults to "
            "[] - no substitutions."
        ),
    )
    # Phase 6C flags
    p.add_argument(
        "--wakeword-enabled",
        action="store_true",
        help="Enable openWakeWord wake-word detection (default: disabled).",
    )
    p.add_argument(
        "--wakeword-model-path",
        type=str,
        default=None,
        help="Absolute path to a wake-word .onnx model (required when --wakeword-enabled).",
    )
    p.add_argument(
        "--wakeword-model-name",
        type=str,
        default="hey-symphony",
        help="Display name surfaced in wake_word events (default: hey-symphony).",
    )
    p.add_argument(
        "--wakeword-threshold",
        type=float,
        default=0.5,
        help="Per-frame score threshold (0..1) above which a frame counts as a hit (default: 0.5).",
    )
    p.add_argument(
        "--wakeword-sustain-frames",
        type=int,
        default=3,
        help="Consecutive above-threshold frames required to fire (default: 3 = 240ms).",
    )
    p.add_argument(
        "--wakeword-cooldown-ms",
        type=int,
        default=2000,
        help="Silence period after a fire before another can fire (default: 2000).",
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
        stt_enabled=not args.no_stt,
        stt_model=args.stt_model,
        max_utterance_seconds=args.max_utterance_seconds,
        partial_interval_ms=args.partial_interval_ms,
        stt_vocab_paths=list(args.stt_vocab_paths),
        wakeword_enabled=args.wakeword_enabled,
        wakeword_model_path=args.wakeword_model_path,
        wakeword_model_name=args.wakeword_model_name,
        wakeword_threshold=args.wakeword_threshold,
        wakeword_sustain_frames=args.wakeword_sustain_frames,
        wakeword_cooldown_ms=args.wakeword_cooldown_ms,
    )
    bridge.init()
    return bridge.run()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        # SIGINT from the parent process - Bridge.run() will have
        # already cleaned up via the iterator-close path. Exit clean.
        sys.exit(0)
    except SystemExit:
        raise
    except Exception as e:
        emit_error("unhandled", repr(e))
        sys.exit(2)
