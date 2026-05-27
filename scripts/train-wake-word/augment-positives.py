"""Phase 6C.0 — augment positive samples 3x with audiomentations.

Reads ~/.symphony-train/positives/*.wav, applies the standard wake-word
augmentation recipe (RIR + background noise + pitch shift + MP3 codec
artifacts), writes 3 augmented copies per source plus the original. Total
output: ~32k clips when source is ~8k.

The augmentation recipe is curated from openWakeWord's training notebook
+ piper-sample-generator's README + audiomentations' wake-word example.

Optional: if ~/.symphony-train/positives-real/ exists, those samples are
ALSO copied (3x weighted via filename prefix `real_NN_`) so the trainer
applies higher loss weight to them. Deferred for v1; the dir is read-only
if not present.

Output: ~/.symphony-train/positives-aug/*.wav
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

TRAIN_DIR = Path(os.path.expanduser("~/.symphony-train"))
POSITIVES_DIR = TRAIN_DIR / "positives"
POSITIVES_REAL_DIR = TRAIN_DIR / "positives-real"
OUTPUT_DIR = TRAIN_DIR / "positives-aug"
NOISE_DIR = TRAIN_DIR / "noise"  # used by AddBackgroundNoise; bootstrap below

# Augmentation multiplier per source clip.
AUG_PER_SAMPLE = 3


def bootstrap_noise_corpus() -> None:
    """Ensure NOISE_DIR has at least a handful of clips so AddBackgroundNoise
    has something to mix in. Falls back to ESC-50 micro-pull if empty.

    Bandwidth-conscious: only fetches if the dir is empty/missing.
    """
    if NOISE_DIR.exists() and any(NOISE_DIR.glob("*.wav")):
        return
    NOISE_DIR.mkdir(parents=True, exist_ok=True)

    # ESC-50 is a 2 GB dataset — too heavy for a bootstrap. Use the FSDKaggle
    # tiny subset OR generate synthetic pink noise if no network.
    try:
        from huggingface_hub import snapshot_download

        print("[augment] Downloading 50-clip noise micro-corpus from FSD50K subset...")
        # Microsoft has a small "noise50" subset on HF — fall back to synthetic
        # if the pull fails (e.g. corp network).
        snapshot_download(
            repo_id="audio-pipelines/noise-samples-50",
            repo_type="dataset",
            local_dir=str(NOISE_DIR),
            allow_patterns=["*.wav"],
            etag_timeout=30,
        )
    except Exception as e:
        print(f"[augment] HF noise pull failed ({e!r}); synthesizing pink noise...")
        import numpy as np
        import soundfile as sf  # type: ignore[import-not-found]

        rng = np.random.default_rng(0)
        for i in range(20):
            # 4-second pink noise clips
            n = 16000 * 4
            white = rng.standard_normal(n)
            # 1/f filter via cumulative sum (cheap pink approximation)
            pink = np.cumsum(white) / np.sqrt(np.arange(1, n + 1))
            pink = pink / np.max(np.abs(pink))
            sf.write(NOISE_DIR / f"pink_{i:03d}.wav", pink.astype("float32"), 16000)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--multiplier",
        type=int,
        default=AUG_PER_SAMPLE,
        help="Augmented copies per source clip (default 3 → ~3x output).",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Delete output dir before augmenting.",
    )
    args = parser.parse_args()

    if not POSITIVES_DIR.exists():
        raise SystemExit(
            f"[augment] missing {POSITIVES_DIR} — run generate-positives.py first."
        )

    # audiomentations + numpy are heavy imports; defer until we've validated paths.
    import numpy as np
    import soundfile as sf  # type: ignore[import-not-found]
    from audiomentations import (  # type: ignore[import-not-found]
        AddBackgroundNoise,
        Compose,
        Mp3Compression,
        PitchShift,
        RoomSimulator,
        TimeStretch,
    )

    if args.clean and OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    bootstrap_noise_corpus()

    augment = Compose(
        [
            TimeStretch(min_rate=0.9, max_rate=1.1, p=0.5),
            PitchShift(min_semitones=-2, max_semitones=2, p=0.5),
            RoomSimulator(p=0.4),
            AddBackgroundNoise(
                sounds_path=str(NOISE_DIR),
                min_snr_db=3.0,
                max_snr_db=15.0,
                p=0.6,
            ),
            Mp3Compression(min_bitrate=32, max_bitrate=128, p=0.2),
        ]
    )

    sources = sorted(POSITIVES_DIR.glob("*.wav"))
    if not sources:
        raise SystemExit(f"[augment] no .wav files in {POSITIVES_DIR}")

    print(f"[augment] {len(sources)} sources × {args.multiplier} multiplier...")
    out_seq = 0
    for src in sources:
        audio, sr = sf.read(src, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        # Copy original unmodified (already a positive — preserves clean signal)
        sf.write(OUTPUT_DIR / f"aug_{out_seq:06d}.wav", audio, sr)
        out_seq += 1
        for _ in range(args.multiplier):
            aug_audio = augment(samples=audio, sample_rate=sr)
            sf.write(OUTPUT_DIR / f"aug_{out_seq:06d}.wav", aug_audio, sr)
            out_seq += 1

    # Layer in real recordings 3× if present
    if POSITIVES_REAL_DIR.exists():
        real_sources = sorted(POSITIVES_REAL_DIR.glob("*.wav"))
        if real_sources:
            print(
                f"[augment] Found {len(real_sources)} real recordings; "
                f"layering 3× weighted via `real_` filename prefix."
            )
            for src in real_sources:
                audio, sr = sf.read(src, dtype="float32")
                if audio.ndim > 1:
                    audio = audio.mean(axis=1)
                for _ in range(3):  # real samples get 3× the augmentation
                    aug_audio = augment(samples=audio, sample_rate=sr)
                    sf.write(
                        OUTPUT_DIR / f"real_{out_seq:06d}.wav",
                        aug_audio,
                        sr,
                    )
                    out_seq += 1

    print(f"[augment] ✓ Wrote {out_seq} clips to {OUTPUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
