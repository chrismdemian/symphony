#!/usr/bin/env bash
# Phase 6C.0 — pull openWakeWord's pre-embedded negative feature dataset.
#
# Source: davidscripka/openwakeword_features on HuggingFace Hub.
# ~5 GB of .npy mel-spectrogram features extracted from ACAV100M, FMA-large,
# FSD50k, Common Voice 11. These are pre-embedded so the training loop
# never has to decode/embed raw audio — saves hours of CPU work.
#
# Idempotent: huggingface_hub.snapshot_download skips already-downloaded
# files based on local SHA.

set -euo pipefail

TRAIN_DIR="${HOME}/.symphony-train"
VENV_DIR="${TRAIN_DIR}/venv"
NEGATIVES_DIR="${TRAIN_DIR}/negatives"

if [[ ! -f "${VENV_DIR}/bin/python" ]]; then
  echo "[negatives] ERROR: ${VENV_DIR} missing. Run setup-wsl.sh first." >&2
  exit 1
fi

mkdir -p "${NEGATIVES_DIR}"
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

echo "[negatives] Downloading davidscripka/openwakeword_features → ${NEGATIVES_DIR}..."
python - <<PY
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="davidscripka/openwakeword_features",
    repo_type="dataset",
    local_dir="${NEGATIVES_DIR}",
    # Negative features are the bulk we need; skip optional positives.
    allow_patterns=[
        "*.npy",      # mel-feature arrays
        "*.json",     # metadata
        "*.md",       # license, README
    ],
    max_workers=4,
)
PY

# Quick summary
total_npy=$(find "${NEGATIVES_DIR}" -name '*.npy' | wc -l)
total_size=$(du -sh "${NEGATIVES_DIR}" | cut -f1)
echo "[negatives] ✓ ${total_npy} .npy files, ${total_size} total in ${NEGATIVES_DIR}"
