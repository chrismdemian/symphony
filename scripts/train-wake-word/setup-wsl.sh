#!/usr/bin/env bash
# Phase 6C.0 — install training deps inside WSL Ubuntu.
#
# Idempotent: re-running on an existing ~/.symphony-train/venv/ refreshes
# deps but doesn't rebuild from scratch. Safe to invoke after a failed run.
#
# Footprint: ~3 GB venv. Lives at ~/.symphony-train/venv/, isolated from
# Symphony's runtime ~/.symphony/ directory.
#
# Run from the repo's WSL-side checkout:
#   wsl -d Ubuntu
#   cd /mnt/c/Users/chris/projects/symphony/scripts/train-wake-word
#   bash setup-wsl.sh

set -euo pipefail

TRAIN_DIR="${HOME}/.symphony-train"
VENV_DIR="${TRAIN_DIR}/venv"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[setup] ERROR: this script must run inside WSL Ubuntu (or any Linux), not Windows." >&2
  exit 1
fi

echo "[setup] Training root: ${TRAIN_DIR}"
mkdir -p "${TRAIN_DIR}"

# --- system deps ----------------------------------------------------------
# audio: libsndfile1 (soundfile), ffmpeg (audiomentations Mp3Compression),
# build: build-essential + python-dev (for numpy/scipy/librosa wheels miss),
# nvidia: handled by WSL2 libcuda shim — nothing to install Ubuntu-side.
if ! dpkg -s python3-venv >/dev/null 2>&1; then
  echo "[setup] Installing system packages (python3-venv, ffmpeg, libsndfile1, build-essential)..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq python3-venv python3-dev ffmpeg libsndfile1 build-essential
else
  echo "[setup] System packages already present."
fi

# --- venv -----------------------------------------------------------------
if [[ ! -f "${VENV_DIR}/bin/python" ]]; then
  echo "[setup] Creating venv at ${VENV_DIR}..."
  python3 -m venv "${VENV_DIR}"
else
  echo "[setup] Venv already exists at ${VENV_DIR}."
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

echo "[setup] Upgrading pip..."
python -m pip install --upgrade --quiet pip wheel setuptools

# --- PyTorch with CUDA (must come BEFORE openwakeword[training]) ----------
# openwakeword[training] pulls torch as a transitive but at the CPU-only
# wheel by default. Install the CUDA 12.1 wheel first so the openwakeword
# extras find it already satisfied and don't downgrade.
echo "[setup] Installing PyTorch (CUDA 12.1 wheel)..."
python -m pip install --quiet --index-url https://download.pytorch.org/whl/cu121 \
  torch torchaudio

# Verify CUDA visible to PyTorch
python - <<'PY'
import torch
if not torch.cuda.is_available():
    raise SystemExit(
        "[setup] ERROR: torch.cuda.is_available() == False. "
        "GPU is not accessible from this WSL session. "
        "Run `wsl --shutdown` from PowerShell and retry."
    )
print(f"[setup] CUDA OK: {torch.cuda.get_device_name(0)} (compute {torch.cuda.get_device_capability(0)})")
PY

# --- training stack -------------------------------------------------------
echo "[setup] Installing training stack (piper-sample-generator, audiomentations, openwakeword[training], huggingface_hub)..."
python -m pip install --quiet \
  piper-sample-generator \
  audiomentations \
  'openwakeword[training]' \
  huggingface_hub \
  scipy

# --- piper voice download -------------------------------------------------
VOICE_DIR="${TRAIN_DIR}/piper-voices"
mkdir -p "${VOICE_DIR}"

# en_US-lessac-medium is the canonical default per piper-sample-generator
# README. Multiple voices listed here for length_scale + accent diversity.
declare -a PIPER_VOICES=(
  "en_US-lessac-medium"
  "en_US-libritts_r-medium"  # 904-speaker LibriTTS-R checkpoint (SLERP-capable)
  "en_GB-alba-medium"        # accent variety
)

for voice in "${PIPER_VOICES[@]}"; do
  ONNX_PATH="${VOICE_DIR}/${voice}.onnx"
  CONFIG_PATH="${VOICE_DIR}/${voice}.onnx.json"
  if [[ -f "${ONNX_PATH}" && -f "${CONFIG_PATH}" ]]; then
    echo "[setup] Piper voice already present: ${voice}"
    continue
  fi
  echo "[setup] Downloading piper voice: ${voice}..."
  # piper voice format: en_US/lessac/medium/en_US-lessac-medium.onnx
  region="${voice%%-*}"      # en_US
  speaker_quality="${voice#*-}"  # lessac-medium
  speaker="${speaker_quality%-*}"  # lessac
  quality="${speaker_quality##*-}"  # medium
  base_url="https://huggingface.co/rhasspy/piper-voices/resolve/main/${region}/${speaker}/${quality}"
  curl -fsSL "${base_url}/${voice}.onnx" -o "${ONNX_PATH}"
  curl -fsSL "${base_url}/${voice}.onnx.json" -o "${CONFIG_PATH}"
done

echo ""
echo "[setup] ✓ Done."
echo "[setup]   venv:           ${VENV_DIR}"
echo "[setup]   piper voices:   ${VOICE_DIR}"
echo "[setup]"
echo "[setup] Next: source ${VENV_DIR}/bin/activate && python generate-positives.py"
