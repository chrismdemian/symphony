"""Phase 6C.0 — synthesize ~8000 "hey symphony" positive samples via piper.

Uses `piper-sample-generator` (Rhasspy) which wraps Piper TTS with:
  - 904 LibriTTS-R speaker embeddings (when using libritts_r-medium voice)
  - SLERP blending between speaker pairs (additional diversity)
  - length_scale sweeping (0.7 - 1.3) for speed variation
  - per-clip volume normalization

Output: ~/.symphony-train/positives/sample_NNNN.wav
Format: 16 kHz mono 16-bit PCM WAV (Piper's native output).

Cross-OS: Linux/WSL2 only. Piper TTS is Linux-native.

Run after `setup-wsl.sh` completes:
    source ~/.symphony-train/venv/bin/activate
    python generate-positives.py
"""
from __future__ import annotations

import argparse
import os
import random
import shutil
import subprocess
import sys
from pathlib import Path

WAKE_PHRASE = "hey symphony"
TRAIN_DIR = Path(os.path.expanduser("~/.symphony-train"))
VOICE_DIR = TRAIN_DIR / "piper-voices"
OUTPUT_DIR = TRAIN_DIR / "positives"

# Voices to sweep across. The libritts_r-medium voice carries 904 speaker
# embeddings — piper-sample-generator's SLERP blending applies to it only.
# The other voices add prosody variety on top.
VOICES = [
    ("en_US-libritts_r-medium", 6000),  # SLERP-capable bulk
    ("en_US-lessac-medium", 1500),       # single-speaker, clean signal
    ("en_GB-alba-medium", 500),          # accent variety
]

# Speed variation. Piper's `--length-scale` is inverse of speed: 0.7 = fast,
# 1.3 = slow. Distribution skewed slightly toward natural speed (1.0).
LENGTH_SCALES = [0.75, 0.85, 1.0, 1.0, 1.0, 1.15, 1.3]


def check_voice(voice_id: str) -> Path:
    """Verify the voice ONNX exists; return its path."""
    onnx_path = VOICE_DIR / f"{voice_id}.onnx"
    if not onnx_path.exists():
        raise SystemExit(
            f"[generate] missing voice: {onnx_path}\n"
            f"           run `bash setup-wsl.sh` first."
        )
    return onnx_path


def run_piper(voice_path: Path, output_dir: Path, count: int, seed: int) -> None:
    """Invoke piper-sample-generator for one voice batch.

    piper-sample-generator's CLI (`python -m piper_sample_generator`) accepts:
      <text>                  Positional phrase
      --model <onnx_path>     Voice
      --max-samples <N>       How many to generate
      --output-dir <dir>      Output WAV directory
      --length-scales <list>  Speed variation (space-separated floats)
      --slerp-weights <list>  Speaker-blend strengths (libritts_r voice only)
      --seed <int>            RNG seed
    """
    cmd = [
        sys.executable,
        "-m",
        "piper_sample_generator",
        WAKE_PHRASE,
        "--model",
        str(voice_path),
        "--max-samples",
        str(count),
        "--output-dir",
        str(output_dir),
        "--length-scales",
        *(str(s) for s in LENGTH_SCALES),
        "--noise-scales",
        "0.333", "0.5", "0.667",  # piper noise = prosody/timbre variation
        "--seed",
        str(seed),
    ]
    if "libritts_r" in voice_path.name:
        # Speaker blending — SLERP weights between pairs of speaker embeddings.
        # piper-sample-generator picks pairs internally; we just provide the
        # weight grid.
        cmd.extend(
            ["--slerp-weights", "0.0", "0.25", "0.5", "0.75", "1.0"]
        )
    print(f"[generate] Running: {' '.join(cmd[:6])} ...")
    subprocess.run(cmd, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Delete output dir before generating (forces re-run).",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Base RNG seed; each voice batch uses seed+i.",
    )
    args = parser.parse_args()

    if args.clean and OUTPUT_DIR.exists():
        print(f"[generate] Cleaning {OUTPUT_DIR}...")
        shutil.rmtree(OUTPUT_DIR)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Skip if already generated AND not --clean
    existing = list(OUTPUT_DIR.glob("*.wav"))
    target = sum(c for _, c in VOICES)
    if len(existing) >= target and not args.clean:
        print(
            f"[generate] {len(existing)} samples already in {OUTPUT_DIR}; "
            f"target was {target}. Pass --clean to regenerate."
        )
        return 0

    random.seed(args.seed)
    for i, (voice_id, count) in enumerate(VOICES):
        voice_path = check_voice(voice_id)
        # Each voice writes to a SUBDIR so per-voice filenames don't collide.
        per_voice_out = OUTPUT_DIR / voice_id
        per_voice_out.mkdir(parents=True, exist_ok=True)
        run_piper(
            voice_path=voice_path,
            output_dir=per_voice_out,
            count=count,
            seed=args.seed + i,
        )

    # Flatten subdirs into OUTPUT_DIR/ for the augmenter to find.
    seq = 0
    for voice_id, _ in VOICES:
        per_voice_out = OUTPUT_DIR / voice_id
        for wav in sorted(per_voice_out.glob("*.wav")):
            target = OUTPUT_DIR / f"sample_{seq:05d}.wav"
            wav.rename(target)
            seq += 1
        per_voice_out.rmdir()

    final_count = len(list(OUTPUT_DIR.glob("*.wav")))
    print(f"[generate] ✓ Wrote {final_count} samples to {OUTPUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
