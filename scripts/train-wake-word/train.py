"""Phase 6C.0 — train hey-symphony.onnx using openWakeWord's training stack.

Calls openWakeWord's training pipeline directly (no community fork dep).
Workflow:
  1. Load positives from ~/.symphony-train/positives-aug/
  2. Embed positives through openWakeWord's frozen speech embedding model
  3. Load pre-embedded negatives from ~/.symphony-train/negatives/
  4. Train a small FCN classifier head (~3k params, 32-unit hidden)
  5. Export ONNX to ~/.symphony-train/output/hey-symphony.onnx

References:
  - openWakeWord's training_models.ipynb (the official manual notebook)
  - automatic_model_training.ipynb (one-call workflow)
  - https://github.com/dscripka/openWakeWord/blob/main/openwakeword/train.py

Symphony's hyperparameters (curated from research synthesis):
  - hidden_size: 32                  (FCN single hidden layer)
  - learning_rate: 1e-4
  - batch_size: 1024
  - max_steps: 50_000                (early-stops on validation plateau)
  - negative_weight: 10              (loss weight; raise to 15-20 if FAR too high)
  - target_FA_per_hour: 0.5          (used for threshold selection)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from pathlib import Path

TRAIN_DIR = Path(os.path.expanduser("~/.symphony-train"))
POSITIVES_AUG_DIR = TRAIN_DIR / "positives-aug"
NEGATIVES_DIR = TRAIN_DIR / "negatives"
OUTPUT_DIR = TRAIN_DIR / "output"
MODEL_NAME = "hey-symphony"

DEFAULT_HIDDEN_SIZE = 32
DEFAULT_LR = 1e-4
DEFAULT_BATCH_SIZE = 1024
DEFAULT_MAX_STEPS = 50_000
DEFAULT_NEG_WEIGHT = 10.0
DEFAULT_TARGET_FA_PER_HR = 0.5


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hidden-size", type=int, default=DEFAULT_HIDDEN_SIZE)
    parser.add_argument("--learning-rate", type=float, default=DEFAULT_LR)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--max-steps", type=int, default=DEFAULT_MAX_STEPS)
    parser.add_argument(
        "--negative-weight",
        type=float,
        default=DEFAULT_NEG_WEIGHT,
        help="Loss weight on negative class. Raise to 15-20 if FAR too high.",
    )
    parser.add_argument(
        "--target-fa-per-hr",
        type=float,
        default=DEFAULT_TARGET_FA_PER_HR,
        help="Target false-accept rate per hour; drives threshold selection.",
    )
    parser.add_argument("--clean", action="store_true")
    args = parser.parse_args()

    if not POSITIVES_AUG_DIR.exists():
        raise SystemExit(f"[train] missing {POSITIVES_AUG_DIR}. Run augment-positives.py.")
    if not NEGATIVES_DIR.exists():
        raise SystemExit(f"[train] missing {NEGATIVES_DIR}. Run download-negatives.sh.")

    pos_count = len(list(POSITIVES_AUG_DIR.glob("*.wav")))
    if pos_count < 1000:
        raise SystemExit(
            f"[train] only {pos_count} positives in {POSITIVES_AUG_DIR}; need >=1000. "
            f"Re-run generate-positives.py + augment-positives.py."
        )
    print(f"[train] {pos_count} augmented positives available.")

    if args.clean and OUTPUT_DIR.exists():
        shutil.rmtree(OUTPUT_DIR)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Heavy imports
    import torch  # noqa: F401 — required by openwakeword[training]

    if not torch.cuda.is_available():
        raise SystemExit(
            "[train] torch.cuda.is_available() == False. "
            "Run `wsl --shutdown` from PowerShell and retry."
        )
    print(f"[train] CUDA: {torch.cuda.get_device_name(0)}")

    # openwakeword.train is the official training entry point. Its API is a
    # bit baroque — we feed it the augmented WAVs + the pre-embedded negative
    # features dir and it handles embedding + training + ONNX export.
    try:
        from openwakeword.train import train as oww_train  # type: ignore[import-not-found]
    except ImportError as e:
        raise SystemExit(
            f"[train] openwakeword[training] not installed: {e}. "
            f"Run `pip install 'openwakeword[training]'` inside the venv."
        ) from e

    config = {
        "model_name": MODEL_NAME,
        "target_phrase": ["hey symphony"],
        "positive_dir": str(POSITIVES_AUG_DIR),
        "negative_features": str(NEGATIVES_DIR),
        "output_dir": str(OUTPUT_DIR),
        "model_type": "dnn",          # FCN classifier head
        "layer_size": args.hidden_size,
        "n_layers": 1,                 # single hidden layer
        "learning_rate": args.learning_rate,
        "batch_size": args.batch_size,
        "max_steps": args.max_steps,
        "negative_class_weight": args.negative_weight,
        "target_false_positives_per_hour": args.target_fa_per_hr,
        "augment": False,              # we pre-augmented in augment-positives.py
    }
    config_path = OUTPUT_DIR / "training_config.json"
    config_path.write_text(json.dumps(config, indent=2))
    print(f"[train] Config written to {config_path}.")

    # `oww_train` reads its config dict and runs the full pipeline.
    print("[train] Starting training (this takes 30-120 minutes on RTX 3060/4060)...")
    oww_train(config)

    # Verify ONNX was produced
    onnx_path = OUTPUT_DIR / f"{MODEL_NAME}.onnx"
    if not onnx_path.exists():
        # Some openWakeWord versions write to model_name/ subdir
        candidate = OUTPUT_DIR / MODEL_NAME / f"{MODEL_NAME}.onnx"
        if candidate.exists():
            shutil.copy(candidate, onnx_path)
            # The "external data" sidecar
            data_candidate = candidate.with_suffix(".onnx.data")
            if data_candidate.exists():
                shutil.copy(data_candidate, onnx_path.with_suffix(".onnx.data"))
        else:
            raise SystemExit(
                f"[train] training completed but {onnx_path} missing. "
                f"Check {OUTPUT_DIR} for what openwakeword.train actually wrote."
            )

    size_kb = onnx_path.stat().st_size / 1024
    print(f"[train] ✓ {onnx_path} ({size_kb:.1f} KB)")
    print(f"[train] Next: bash export-and-commit.sh")
    return 0


if __name__ == "__main__":
    sys.exit(main())
