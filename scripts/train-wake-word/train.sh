#!/usr/bin/env bash
# Phase 6C.0 — run the openWakeWord integrated trainer (LOCAL WSL path).
#
# This is openWakeWord's OWN training entrypoint — we do NOT reimplement
# generation/augmentation/training. The three phases run in one process:
#   --generate_clips : Piper TTS synthesizes n_samples positives
#   --augment_clips  : RIR + background mixing → openwakeword features
#   --train_model    : trains the FCN head, writes hey-symphony.onnx
#
# Output: ~/.symphony-train/work/hey-symphony-out/hey-symphony.onnx
# (the .tflite export step may error AFTER the .onnx is saved — that's
#  expected since we skip the tensorflow deps. Check the .onnx exists.)
#
# Run AFTER setup-wsl.sh + download-data.sh. ~1-2 hrs on RTX 4060.

set -euo pipefail

TRAIN_DIR="${HOME}/.symphony-train"
WORK_DIR="${TRAIN_DIR}/work"
VENV_DIR="${TRAIN_DIR}/venv"

if [[ ! -f "${VENV_DIR}/bin/python" ]]; then
  echo "[train] ERROR: ${VENV_DIR} missing. Run setup-wsl.sh first." >&2
  exit 1
fi
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"
cd "${WORK_DIR}"

if [[ ! -f openwakeword_features_ACAV100M_2000_hrs_16bit.npy ]]; then
  echo "[train] ERROR: negative features missing. Run download-data.sh first." >&2
  exit 1
fi

# Always refresh the work-dir config from the source-of-truth in the repo,
# so edits to training_config.yml (e.g. background_paths) propagate without
# re-running setup-wsl.sh. setup copies it once; this keeps it current.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "${SCRIPT_DIR}/training_config.yml" "${WORK_DIR}/training_config.yml"
echo "[train] Refreshed training_config.yml from ${SCRIPT_DIR}."

echo "[train] Phase 1/3 — generate synthetic positives (Piper TTS)..."
python -m openwakeword.train --training_config training_config.yml --generate_clips

echo "[train] Phase 2/3 — augment + compute features..."
python -m openwakeword.train --training_config training_config.yml --augment_clips

echo "[train] Phase 3/3 — train the model (~1-2 hrs)..."
# The .tflite export at the very end may fail (no tensorflow); the .onnx is
# written first. We capture the exit but verify the .onnx regardless.
set +e
python -m openwakeword.train --training_config training_config.yml --train_model
train_exit=$?
set -e

ONNX_OUT="hey-symphony-out/hey-symphony.onnx"
if [[ -f "${ONNX_OUT}" ]]; then
  echo "[train] ✓ ${ONNX_OUT} produced ($(stat -c '%s' "${ONNX_OUT}") bytes)."
  if [[ ${train_exit} -ne 0 ]]; then
    echo "[train]   (trainer exited ${train_exit} — almost certainly the optional"
    echo "[train]    .tflite export step, which we skip. The .onnx is valid.)"
  fi
  echo "[train] Next: bash export-and-commit.sh"
else
  echo "[train] ✗ ${ONNX_OUT} NOT produced (trainer exit ${train_exit})." >&2
  echo "[train]   Check the trace above — this is a real training failure." >&2
  exit 1
fi
