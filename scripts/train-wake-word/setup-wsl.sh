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

# --- pick a Python interpreter --------------------------------------------
# We use the SYSTEM python3 (3.10/3.11/3.12 all work). The Colab run proved
# 3.12 + the torchaudio shim gets past every import; we skip the TFLite-
# export deps (tensorflow-cpu==2.8.1 was the only hard <=3.11 pin, and we
# don't install it). Only fall back to deadsnakes 3.11 if the system python
# is genuinely too old (<3.10).
PY_BIN="python3"
sys_ver="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo "0.0")"
sys_minor="${sys_ver#3.}"
if [[ "${sys_ver%%.*}" != "3" || "${sys_minor}" -lt 10 ]]; then
  echo "[setup] system python3 is ${sys_ver} (<3.10); installing ${PY_TARGET} via deadsnakes..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq software-properties-common
  sudo add-apt-repository -y ppa:deadsnakes/ppa
  sudo apt-get update -qq
  sudo apt-get install -y -qq "python${PY_TARGET}" "python${PY_TARGET}-venv" "python${PY_TARGET}-dev"
  PY_BIN="python${PY_TARGET}"
fi
echo "[setup] Using interpreter: ${PY_BIN} ($(${PY_BIN} --version 2>&1))"

# --- system deps ----------------------------------------------------------
# Only invoke sudo if something is actually missing — lets the script run
# UNATTENDED when the deps were pre-installed (sudo needs an interactive
# password on most WSL setups). The pre-install one-liner is in README
# Path B prerequisites.
# NOTE: probe the VERSIONED venv package (python3.12-venv), NOT the bare
# `python3-venv` metapackage. On Ubuntu 24.04 the versioned one is what
# provides ensurepip for `python3 -m venv`; users commonly install just
# that. Requiring the metapackage caused a false-missing → sudo hang.
APT_PKGS=(python3-dev python3-pip ffmpeg libsndfile1 build-essential git wget)
MISSING_PKGS=()
for p in "${APT_PKGS[@]}"; do
  dpkg -s "${p}" >/dev/null 2>&1 || MISSING_PKGS+=("${p}")
done
ver_venv="python${sys_ver}-venv"
# Accept EITHER the versioned package OR the metapackage as satisfying venv.
if ! dpkg -s "${ver_venv}" >/dev/null 2>&1 && ! dpkg -s "python3-venv" >/dev/null 2>&1; then
  MISSING_PKGS+=("${ver_venv}")
fi
if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
  echo "[setup] Installing missing system packages (needs sudo): ${MISSING_PKGS[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${MISSING_PKGS[@]}"
else
  echo "[setup] All system packages present — skipping sudo apt."
fi

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
# MUST pin the v2.0.0 TAG. The repo's main branch restructured and no longer
# has `generate_samples.py` / `piper_train/` at root — but openWakeWord's
# train.py hardcodes `from generate_samples import generate_samples`, which
# only works with the v2.0.0 layout. v2.0.0 also matches the voice model
# release we download below.
cd "${WORK_DIR}"
PSG_OK=0
if [[ -f piper-sample-generator/generate_samples.py ]]; then
  PSG_OK=1
fi
if [[ "${PSG_OK}" -ne 1 ]]; then
  echo "[setup] Cloning piper-sample-generator @ v2.0.0 (correct layout)..."
  rm -rf piper-sample-generator
  git clone --depth 1 --branch v2.0.0 \
    https://github.com/rhasspy/piper-sample-generator
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
# numpy<2 FIRST — the 2024-era stack (numba/librosa/openwakeword) breaks on
# numpy 2.x. piper-phonemize-cross replaces piper-phonemize (no cp312 wheel
# for the latter; the -cross fork provides the same `piper_phonemize` module
# WITH a cp312 wheel). audiomentations pinned to the version
# piper-sample-generator v2.0.0 requires.
python -m pip install --quiet 'numpy<2'
python -m pip install --quiet \
  piper-phonemize-cross webrtcvad \
  mutagen torchinfo torchmetrics \
  'audiomentations==0.33.0' torch-audiomentations acoustics \
  pronouncing datasets scipy tqdm pyyaml \
  'deep-phonemizer'
# Verify the piper_phonemize module (provided by -cross) imports + exposes
# the symbol generate_samples.py needs.
python - <<'PY'
try:
    from piper_phonemize import phonemize_espeak  # noqa: F401
    print("[setup] piper_phonemize.phonemize_espeak OK (via piper-phonemize-cross)")
except Exception as e:
    raise SystemExit(f"[setup] ERROR: piper_phonemize import failed: {e!r}")
PY
# speechbrain is used for some augmentation paths; install best-effort
# (its old pins can conflict on 3.11 — failure here is non-fatal for the
# core ONNX training path).
python -m pip install --quiet speechbrain || \
  echo "[setup] WARNING: speechbrain install failed (non-fatal for ONNX path)."

# --- torchaudio backend-API compat shim -----------------------------------
# torch_audiomentations 0.11.0 (openWakeWord's pin) calls
# torchaudio.set_audio_backend() at import time, which torchaudio >=2.1
# REMOVED. Rather than pin an ancient torch (fragile vs the 4060's CUDA),
# append no-op shims to the venv's torchaudio __init__ so the legacy import
# resolves. Idempotent (guards on a marker comment). Verified necessary —
# this is the exact break the Colab run hit.
python - <<'PY'
import torchaudio
init = torchaudio.__file__
src = open(init, encoding="utf-8").read()
if "compat shim: torchaudio backend" not in src:
    with open(init, "a", encoding="utf-8") as f:
        f.write(
            "\n\n# compat shim: torchaudio backend API removed in >=2.1\n"
            "def set_audio_backend(*a, **k):\n    pass\n"
            "def get_audio_backend(*a, **k):\n    return None\n"
            "def list_audio_backends(*a, **k):\n    return []\n"
        )
    print("[setup] Patched torchaudio with backend-API shim.")
else:
    print("[setup] torchaudio shim already present.")
PY

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
