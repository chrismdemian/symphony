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

# --- Background noise: ESC-50 (NON-FATAL) ---------------------------------
# The notebook's AudioSet source (agkphysics/AudioSet bal_train09.tar) is
# now HTTP 404. ESC-50 (2000 environmental-sound clips, ~600 MB, stable
# GitHub release) is the replacement. The WHOLE block is best-effort: a
# failure here must NOT block the critical feature download below, so we
# drop `set -e` around it. The trainer's mix_clips_batch needs a non-empty
# background list — without it, augmentation can't run — so we warn loudly
# if this fails, but features (the negative TRAINING data) are downloaded
# regardless and a model can still be produced (less noise-robust).
if [[ ! -d background || -z "$(ls -A background 2>/dev/null)" ]]; then
  echo "[data] Downloading ESC-50 background noise (~600 MB)..."
  set +e
  if wget -q -O esc50.zip \
      "https://github.com/karolpiczak/ESC-50/archive/refs/heads/master.zip"; then
    python - <<'PY'
import os, glob, zipfile
import numpy as np
import scipy.io.wavfile
import datasets
from tqdm import tqdm

with zipfile.ZipFile("esc50.zip") as z:
    z.extractall(".")
out = "./background"
os.makedirs(out, exist_ok=True)
files = glob.glob("ESC-50-master/audio/*.wav")
# Reuse the SAME datasets Audio resampling path that worked for MIT RIRs.
ds = datasets.Dataset.from_dict({"audio": files}).cast_column(
    "audio", datasets.Audio(sampling_rate=16000),
)
for row in tqdm(ds):
    name = os.path.basename(row["audio"]["path"])
    scipy.io.wavfile.write(
        os.path.join(out, name), 16000,
        (row["audio"]["array"] * 32767).astype(np.int16),
    )
print(f"[data] ESC-50 background: {len(files)} clips resampled to 16kHz.")
PY
    bg_rc=$?
  else
    echo "[data] WARNING: ESC-50 download failed (network?). Continuing WITHOUT background."
    bg_rc=1
  fi
  set -e
  if [[ "${bg_rc:-1}" -ne 0 ]]; then
    echo "[data] WARNING: background prep failed; the model will train without"
    echo "[data]          noise augmentation (less robust). Features still download."
  fi
fi

# --- pre-computed openWakeWord features (CRITICAL — always runs) ----------
# These are the negative TRAINING data + FP-validation set. Verified
# reachable (HTTP 200). Use --continue so a partial file from an
# interrupted run resumes instead of being skipped as "present".
if [[ ! -s openwakeword_features_ACAV100M_2000_hrs_16bit.npy ]]; then
  echo "[data] Downloading ACAV100M negative features (~2 GB)..."
  wget -q --show-progress -c \
    "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/openwakeword_features_ACAV100M_2000_hrs_16bit.npy"
fi
if [[ ! -s validation_set_features.npy ]]; then
  echo "[data] Downloading validation features (~0.3 GB)..."
  wget -q --show-progress -c \
    "https://huggingface.co/datasets/davidscripka/openwakeword_features/resolve/main/validation_set_features.npy"
fi

echo ""
echo "[data] ✓ Datasets ready in ${WORK_DIR}:"
du -sh mit_rirs background *.npy 2>/dev/null | sed 's/^/[data]   /'
echo "[data] Next: bash train.sh"
