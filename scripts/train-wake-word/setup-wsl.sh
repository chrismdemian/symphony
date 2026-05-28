#!/usr/bin/env bash
# Phase 6C.0 — set up the openWakeWord LOCAL training environment in WSL.
#
# This is the GPU-local alternative to the Colab path (see README.md). It
# faithfully follows openWakeWord's automatic_model_training.ipynb recipe:
# clone piper-sample-generator + openwakeword from git, install the deps
# needed for the ONNX training path, and download the RIR / background /
# pre-computed-feature datasets.
#
# IMPORTANT — Python version: openWakeWord's training pins (speechbrain,
# the optional tensorflow/onnx_tf TFLite-export stack) target Python
# 3.10/3.11. The default Ubuntu-on-WSL Python may be 3.12, where some pins
# fail to build. This script creates a 3.11 venv via the deadsnakes PPA if
# the system Python is newer than 3.11. We SKIP the TFLite-export deps
# (tensorflow-cpu / onnx_tf) entirely — Symphony only ships .onnx, and the
# trainer writes the .onnx BEFORE the optional .tflite conversion step.
#
# Footprint: ~6 GB (venv + git clones + voice model). The data downloads
# (RIR + background + ~2 GB features) happen in a separate step so this
# script stays re-runnable.
#
# Run from the repo's WSL-side checkout:
#   wsl -d Ubuntu
#   cd /mnt/c/Users/chris/projects/symphony/scripts/train-wake-word
#   bash setup-wsl.sh

set -euo pipefail

TRAIN_DIR="${HOME}/.symphony-train"
WORK_DIR="${TRAIN_DIR}/work"
VENV_DIR="${TRAIN_DIR}/venv"
PY_TARGET="3.11"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[setup] ERROR: run inside WSL Ubuntu, not Windows." >&2
  exit 1
fi

echo "[setup] Training root: ${TRAIN_DIR}"
mkdir -p "${WORK_DIR}"

# --- pick a Python interpreter (prefer 3.11; fall back to system) --------
PY_BIN=""
if command -v "python${PY_TARGET}" >/dev/null 2>&1; then
  PY_BIN="python${PY_TARGET}"
else
  sys_ver="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "0.0")"
  echo "[setup] python${PY_TARGET} not found; system python3 is ${sys_ver}."
  if [[ "${sys_ver}" == "3.10" || "${sys_ver}" == "3.11" ]]; then
    PY_BIN="python3"
  else
    echo "[setup] Installing Python ${PY_TARGET} via deadsnakes PPA (openWakeWord training pins need <=3.11)..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq software-properties-common
    sudo add-apt-repository -y ppa:deadsnakes/ppa
    sudo apt-get update -qq
    sudo apt-get install -y -qq "python${PY_TARGET}" "python${PY_TARGET}-venv" "python${PY_TARGET}-dev"
    PY_BIN="python${PY_TARGET}"
  fi
fi
echo "[setup] Using interpreter: ${PY_BIN} ($(${PY_BIN} --version 2>&1))"

# --- system deps ----------------------------------------------------------
echo "[setup] Installing system packages (ffmpeg, libsndfile1, build tools, git)..."
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg libsndfile1 build-essential git wget

# --- venv -----------------------------------------------------------------
if [[ ! -f "${VENV_DIR}/bin/python" ]]; then
  echo "[setup] Creating venv at ${VENV_DIR}..."
  "${PY_BIN}" -m venv "${VENV_DIR}"
fi
# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"
python -m pip install --upgrade --quiet pip wheel setuptools

# --- PyTorch (CUDA 12.1) --------------------------------------------------
echo "[setup] Installing PyTorch (CUDA 12.1)..."
python -m pip install --quiet --index-url https://download.pytorch.org/whl/cu121 torch torchaudio
python - <<'PY'
import torch
if not torch.cuda.is_available():
    raise SystemExit(
        "[setup] ERROR: torch.cuda.is_available() == False. "
        "Run `wsl --shutdown` from PowerShell and retry."
    )
print(f"[setup] CUDA OK: {torch.cuda.get_device_name(0)}")
PY

# --- clone piper-sample-generator + its voice model -----------------------
cd "${WORK_DIR}"
if [[ ! -d piper-sample-generator ]]; then
  echo "[setup] Cloning piper-sample-generator..."
  git clone --depth 1 https://github.com/rhasspy/piper-sample-generator
fi
mkdir -p piper-sample-generator/models
if [[ ! -f piper-sample-generator/models/en_US-libritts_r-medium.pt ]]; then
  echo "[setup] Downloading piper voice model (en_US-libritts_r-medium, ~60MB)..."
  wget -q -O piper-sample-generator/models/en_US-libritts_r-medium.pt \
    'https://github.com/rhasspy/piper-sample-generator/releases/download/v2.0.0/en_US-libritts_r-medium.pt'
fi

# --- clone openwakeword (editable, for the training entrypoint) -----------
if [[ ! -d openwakeword ]]; then
  echo "[setup] Cloning openwakeword (training fork)..."
  git clone --depth 1 https://github.com/dscripka/openwakeword
fi

# --- training deps (ONNX path only — NO tensorflow / onnx_tf) -------------
# These are the deps the trainer actually needs to GENERATE + AUGMENT +
# TRAIN and write the .onnx. We deliberately OMIT tensorflow-cpu / onnx_tf /
# tensorflow_probability — those are only for the optional .tflite export
# which errors harmlessly AFTER the .onnx is saved.
echo "[setup] Installing training deps (ONNX path)..."
python -m pip install --quiet -e ./openwakeword
python -m pip install --quiet \
  piper-phonemize webrtcvad \
  mutagen torchinfo torchmetrics \
  audiomentations torch-audiomentations acoustics \
  pronouncing datasets scipy tqdm pyyaml \
  'deep-phonemizer'
# speechbrain is used for some augmentation paths; install best-effort
# (its old pins can conflict on 3.11 — failure here is non-fatal for the
# core ONNX training path).
python -m pip install --quiet speechbrain || \
  echo "[setup] WARNING: speechbrain install failed (non-fatal for ONNX path)."

# --- download embedding backbone into the editable openwakeword resources -
RES_DIR="openwakeword/openwakeword/resources/models"
mkdir -p "${RES_DIR}"
for f in embedding_model.onnx melspectrogram.onnx; do
  if [[ ! -f "${RES_DIR}/${f}" ]]; then
    echo "[setup] Downloading ${f}..."
    wget -q -O "${RES_DIR}/${f}" \
      "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/${f}"
  fi
done

# --- copy Symphony's training config into the work dir --------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "${SCRIPT_DIR}/training_config.yml" "${WORK_DIR}/training_config.yml"

echo ""
echo "[setup] ✓ Environment ready at ${WORK_DIR}"
echo "[setup]   venv:                 ${VENV_DIR}"
echo "[setup]   piper-sample-generator: cloned + voice model present"
echo "[setup]   openwakeword:           editable install"
echo "[setup]   training_config.yml:    copied"
echo "[setup]"
echo "[setup] Next: bash download-data.sh   (RIR + background + ~2GB features)"
echo "[setup] Then: bash train.sh"
