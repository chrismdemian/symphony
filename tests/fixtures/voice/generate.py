"""Phase 6A — PCM fixture generator via OS TTS.

Uses pyttsx3 (Windows SAPI / macOS NSSpeechSynthesizer / Linux espeak)
to synthesize real speech that Silero VAD reliably fires on. The
output is normalized to 16 kHz mono LE int16 PCM and committed to the
repo, so test runs DON'T need pyttsx3 — only fixture regeneration does.

Two fixtures committed:
- `diagnose-3s.pcm`: short utterance + silence framing (~3 s total)
- `silence-2s.pcm`:  2 s pure silence + tiny dither

Regenerate (one-time, when you want different content):
    ~/.symphony/voice-env/bin/python tests/fixtures/voice/generate.py

Note: TTS output is deterministic on a given OS+voice, but cross-OS the
byte content WILL differ. CHECKSUMS.txt is regenerated alongside the
WAV so reviewers can spot accidental fixture churn.
"""
from __future__ import annotations

import hashlib
import io
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
TARGET_SR = 16000


def synth_via_tts(text: str) -> np.ndarray:
    """Return float32 mono signal in [-1, 1] at TARGET_SR sample rate.

    Uses pyttsx3 to write to a temp WAV, then loads + resamples to 16kHz
    mono. Importing pyttsx3 only inside this function so the rest of
    the module loads without the dep.
    """
    import pyttsx3  # type: ignore[import-not-found]

    engine = pyttsx3.init()
    # 150 wpm is roughly the SAPI default; explicit for repro.
    engine.setProperty("rate", 150)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp_path = tmp.name
    engine.save_to_file(text, tmp_path)
    engine.runAndWait()

    with wave.open(tmp_path, "rb") as wav:
        n = wav.getnframes()
        raw = wav.readframes(n)
        n_channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sr = wav.getframerate()

    if sample_width == 2:
        arr = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    else:
        raise RuntimeError(f"unexpected sample width {sample_width}")

    if n_channels > 1:
        arr = arr.reshape(-1, n_channels).mean(axis=1)

    # Simple linear resampling to 16kHz if needed (SAPI defaults to 22050)
    if sr != TARGET_SR:
        target_n = int(len(arr) * TARGET_SR / sr)
        old_x = np.linspace(0, 1, len(arr))
        new_x = np.linspace(0, 1, target_n)
        arr = np.interp(new_x, old_x, arr).astype(np.float32)

    Path(tmp_path).unlink(missing_ok=True)
    return arr


def silence(duration_ms: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(duration_ms / 1000 * TARGET_SR)
    return (rng.standard_normal(n) * 1e-5).astype(np.float32)


def to_int16_pcm(signal: np.ndarray) -> bytes:
    clipped = np.clip(signal, -1.0, 1.0)
    i16 = (clipped * 32760).astype(np.int16)
    return i16.astype("<i2").tobytes()


def build_diagnose() -> bytes:
    # Single utterance long enough that Silero clearly fires. Use a
    # phrase with clear syllables and varied formants.
    speech = synth_via_tts("Symphony voice diagnose. Testing one two three.")
    # Frame with silence on each side
    parts = [silence(500, seed=1), speech, silence(500, seed=2)]
    return to_int16_pcm(np.concatenate(parts))


def build_silence() -> bytes:
    return to_int16_pcm(silence(2000, seed=10))


def main() -> int:
    diagnose = build_diagnose()
    (HERE / "diagnose-3s.pcm").write_bytes(diagnose)
    print(f"wrote diagnose-3s.pcm ({len(diagnose)} bytes)")

    sil = build_silence()
    (HERE / "silence-2s.pcm").write_bytes(sil)
    print(f"wrote silence-2s.pcm ({len(sil)} bytes)")

    checksum_lines = [
        f"diagnose-3s.pcm  {hashlib.sha256(diagnose).hexdigest()}",
        f"silence-2s.pcm  {hashlib.sha256(sil).hexdigest()}",
    ]
    (HERE / "CHECKSUMS.txt").write_text("\n".join(checksum_lines) + "\n")
    print("wrote CHECKSUMS.txt")
    _ = io, sys  # quiet unused imports under future static checkers
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
