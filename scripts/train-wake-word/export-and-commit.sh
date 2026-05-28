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
OUTPUT_DIR="${TRAIN_DIR}/work/hey-symphony-out"
REPO_ASSETS="/mnt/c/Users/chris/projects/symphony/assets/wake-models"

ONNX_SRC="${OUTPUT_DIR}/hey-symphony.onnx"
ONNX_DATA_SRC="${OUTPUT_DIR}/hey-symphony.onnx.data"

# Allow overriding the source .onnx (e.g. a Colab-trained model downloaded
# to ~/Downloads). Usage: bash export-and-commit.sh /path/to/hey-symphony.onnx
if [[ -n "${1:-}" ]]; then
  ONNX_SRC="$1"
  ONNX_DATA_SRC="${1}.data"
fi

if [[ ! -f "${ONNX_SRC}" ]]; then
  echo "[export] ERROR: ${ONNX_SRC} missing." >&2
  echo "[export]   Local path: run train.sh first." >&2
  echo "[export]   Colab path: bash export-and-commit.sh /path/to/downloaded/hey-symphony.onnx" >&2
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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/training_config.yml" ]]; then
  cp "${SCRIPT_DIR}/training_config.yml" "${REPO_ASSETS}/training-config.yml"
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
