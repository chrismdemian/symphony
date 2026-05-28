#!/usr/bin/env bash
# Phase 6C.0 — download the training datasets for the LOCAL WSL path.
#
# Faithfully follows openWakeWord's automatic_model_training.ipynb cells
# 8-10: MIT RIRs + an AudioSet background slice + FMA music + the two
# pre-computed feature .npy files (~2 GB training, ~0.3 GB validation).
#
# Idempotent: skips any dataset already present. Total download ~3-4 GB.
# Run AFTER setup-wsl.sh.

set -euo pipefail

TRAIN_DIR="${HOME}/.symphony-train"
WORK_DIR="${TRAIN_DIR}/work"
VENV_DIR="${TRAIN_DIR}/venv"

if [[ ! -f "${VENV_DIR}/bin/python" ]]; then
  echo "[data] ERROR: ${VENV_DIR} missing. Run setup-wsl.sh first." >&2
  exit 1
fi
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"
cd "${WORK_DIR}"

# --- MIT environmental impulse responses ----------------------------------
# Re-attempt when the dir is missing OR empty (a prior partial/failed run
# leaves an empty mit_rirs/ that a bare -d test would wrongly treat as done).
if [[ ! -d mit_rirs || -z "$(ls -A mit_rirs 2>/dev/null)" ]]; then
  echo "[data] Downloading MIT RIRs via HuggingFace datasets..."
  python - <<'PY'
import os
import numpy as np
import scipy.io.wavfile
import datasets
from tqdm import tqdm

out = "./mit_rirs"
os.makedirs(out, exist_ok=True)
ds = datasets.load_dataset(
    "davidscripka/MIT_environmental_impulse_responses",
    split="train", streaming=True,
)
for row in tqdm(ds):
    name = row["audio"]["path"].split("/")[-1]
    scipy.io.wavfile.write(
        os.path.join(out, name), 16000,
        (row["audio"]["array"] * 32767).astype(np.int16),
    )
print("[data] MIT RIRs done.")
PY
fi

# --- AudioSet background slice (one balanced-train tar) --------------------
if [[ ! -d audioset_16k || -z "$(ls -A audioset_16k 2>/dev/null)" ]]; then
  echo "[data] Downloading AudioSet slice (bal_train09.tar)..."
  mkdir -p audioset
  wget -q -O audioset/bal_train09.tar \
    "https://huggingface.co/datasets/agkphysics/AudioSet/resolve/main/data/bal_train09.tar"
  (cd audioset && tar -xf bal_train09.tar)
  python - <<'PY'
import os
from pathlib import Path
import numpy as np
import scipy.io.wavfile
import datasets
from tqdm import tqdm

out = "./audioset_16k"
os.makedirs(out, exist_ok=True)
files = [str(p) for p in Path("audioset/audio").glob("**/*.flac")]
ds = datasets.Dataset.from_dict({"audio": files}).cast_column(
    "audio", datasets.Audio(sampling_rate=16000),
)
for row in tqdm(ds):
    name = row["audio"]["path"].split("/")[-1].replace(".flac", ".wav")
    scipy.io.wavfile.write(
        os.path.join(out, name), 16000,
        (row["audio"]["array"] * 32767).astype(np.int16),
    )
print("[data] AudioSet slice done.")
PY
fi

# --- FMA music (optional second background source) -------------------------
# The notebook also pulls FMA-small. It's ~7 GB; for a pilot the AudioSet
# slice alone is enough background variety. Uncomment to add FMA.
# (Left out by default to keep the download manageable. The training config
#  lists ./fma but the trainer tolerates a missing/empty background dir.)
if [[ ! -d fma ]]; then
  mkdir -p fma
  echo "[data] (skipping FMA-small — ~7GB; AudioSet slice is enough for a pilot.)"
fi

# --- pre-computed openWakeWord features ------------------------------------
if [[ ! -f openwakeword_features_ACAV100M_2000_hrs_16bit.npy ]]; then
  echo "[data] Downloading ACAV100M negative features (~2 GB)..."
  wget -q --show-progress \
    "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy"
fi
if [[ ! -f validation_set_features.npy ]]; then
  echo "[data] Downloading validation features (~0.3 GB)..."
  wget -q --show-progress \
    "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy"
fi

echo ""
echo "[data] ✓ Datasets ready in ${WORK_DIR}:"
du -sh mit_rirs audioset_16k *.npy 2>/dev/null | sed 's/^/[data]   /'
echo "[data] Next: bash train.sh"
