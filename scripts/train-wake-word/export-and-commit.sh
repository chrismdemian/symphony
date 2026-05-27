#!/usr/bin/env bash
# Phase 6C.0 — finalize the trained model into the repo.
#
# Moves ~/.symphony-train/output/hey-symphony.onnx into the repo's
# assets/wake-models/ directory, writes a SHA-256 checksum file, and prints
# a `git add` line for the user to run next.
#
# Cross-OS quirk: WSL2 can write to /mnt/c/... — the repo lives there —
# but `git` from the Windows side is what makes the commit. This script
# just stages the artifact; the user runs `git add` + `git commit` from
# PowerShell.

set -euo pipefail

TRAIN_DIR="${HOME}/.symphony-train"
OUTPUT_DIR="${TRAIN_DIR}/output"
REPO_ASSETS="/mnt/c/Users/chris/projects/symphony/assets/wake-models"

ONNX_SRC="${OUTPUT_DIR}/hey-symphony.onnx"
ONNX_DATA_SRC="${OUTPUT_DIR}/hey-symphony.onnx.data"

if [[ ! -f "${ONNX_SRC}" ]]; then
  echo "[export] ERROR: ${ONNX_SRC} missing. Run train.py first." >&2
  exit 1
fi

mkdir -p "${REPO_ASSETS}"

cp "${ONNX_SRC}" "${REPO_ASSETS}/hey-symphony.onnx"
if [[ -f "${ONNX_DATA_SRC}" ]]; then
  cp "${ONNX_DATA_SRC}" "${REPO_ASSETS}/hey-symphony.onnx.data"
fi

# Write CHECKSUMS.txt for reproducibility / supply-chain visibility.
{
  cd "${REPO_ASSETS}"
  echo "# hey-symphony.onnx — SHA-256 manifest"
  echo "# generated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sha256sum hey-symphony.onnx*
} > "${REPO_ASSETS}/CHECKSUMS.txt"

# Snapshot the training config alongside the model for audit trail.
if [[ -f "${OUTPUT_DIR}/training_config.json" ]]; then
  cp "${OUTPUT_DIR}/training_config.json" "${REPO_ASSETS}/training-config.json"
fi

size=$(stat -c '%s' "${REPO_ASSETS}/hey-symphony.onnx")
size_kb=$(awk "BEGIN {printf \"%.1f\", ${size}/1024}")

echo "[export] ✓ Copied to ${REPO_ASSETS}/"
echo "[export]   hey-symphony.onnx       (${size_kb} KB)"
[[ -f "${REPO_ASSETS}/hey-symphony.onnx.data" ]] && echo "[export]   hey-symphony.onnx.data"
echo "[export]   CHECKSUMS.txt"
echo "[export]   training-config.json"
echo ""
echo "[export] From Windows PowerShell:"
echo "[export]   git add assets/wake-models/"
echo "[export]   git commit -m \"feat(voice): hey-symphony.onnx — trained model\""
echo "[export]   git push"
