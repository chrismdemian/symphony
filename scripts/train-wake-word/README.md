# Training `hey-symphony.onnx`

Operational runbook for producing `assets/wake-models/hey-symphony.onnx`. This is a **one-time** operation per model revision — the resulting `.onnx` ships with Symphony, so end-users never run this. Re-run only when you want to retrain (e.g. adding 50 real recordings for FRR improvement, or upgrading the architecture).

## Prerequisites

| Requirement | Verified by |
|---|---|
| WSL2 + Ubuntu (22.04 or newer) | `wsl --status` shows `Default Version: 2` |
| GPU visible inside WSL | `wsl -d Ubuntu --exec /usr/lib/wsl/lib/nvidia-smi` shows your GPU |
| ≥8 GB VRAM | RTX 3060 12 GB explicitly called out as baseline; RTX 4060 8 GB confirmed sufficient |
| ≥40 GB free disk on `~` (WSL side) | TTS positives ~2 GB + negatives ~5 GB + checkpoints ~2 GB |
| Internet | piper voice download (~100 MB), HF dataset (~5 GB), pip deps (~3 GB) |

If `nvidia-smi` inside WSL fails with `NVML init failed`, run **`wsl --shutdown`** from PowerShell (NOT a full Windows restart — `wsl --shutdown` only restarts the WSL VM in ~10 s) and re-probe. This fixes the most common transient GPU-in-WSL bug.

## End-to-end runbook (one shell session)

```bash
# Open a WSL Ubuntu shell from PowerShell:
wsl -d Ubuntu

# Inside WSL:
cd /mnt/c/Users/chris/projects/symphony/scripts/train-wake-word

# 1. Install deps (~5 min, idempotent). Creates ~/.symphony-train/venv/
bash setup-wsl.sh

# 2. Generate ~8k synthetic positives via piper-sample-generator (~80 s on RTX 4060).
#    Output: ~/.symphony-train/positives/*.wav
bash -c "source ~/.symphony-train/venv/bin/activate && python generate-positives.py"

# 3. Augment 3x via audiomentations (RIR + noise + pitch + codec) (~3-5 min).
#    Output: ~/.symphony-train/positives-aug/*.wav (~27k clips)
bash -c "source ~/.symphony-train/venv/bin/activate && python augment-positives.py"

# 4. Download HuggingFace pre-embedded negatives (~5 GB, ~3-5 min on broadband).
#    Output: ~/.symphony-train/negatives/*.npy
bash download-negatives.sh

# 5. Train the model (~1-2 hrs on RTX 4060 8 GB).
#    Output: ~/.symphony-train/output/hey-symphony.onnx + .onnx.data
bash -c "source ~/.symphony-train/venv/bin/activate && python train.py"

# 6. Validate + export to the repo (~5 s).
#    Output: <repo>/assets/wake-models/hey-symphony.onnx + .onnx.data + CHECKSUMS.txt
bash export-and-commit.sh

# 7. From Windows side (NOT WSL): commit the new artifacts
exit  # leave WSL
```

```powershell
# Back in PowerShell at the repo root:
git add assets/wake-models/
git commit -m "feat(voice): hey-symphony.onnx — Apache-2.0-clean wake-word model"
git push
```

## What gets installed (WSL Ubuntu side, none on Windows)

Inside `~/.symphony-train/venv/`:
- `piper-sample-generator` — Rhasspy's TTS sample generator, 904 LibriTTS-R speakers
- `audiomentations` — augmentation pipeline (RIR, noise, pitch, codec artifacts)
- `openwakeword[training]` — training extras (PyTorch CUDA, scikit-learn, librosa, mutagen)
- `huggingface_hub` — for downloading pre-embedded negatives

The `~/.symphony-train/` directory is **isolated from `~/.symphony/`** (Symphony's runtime data dir, shared with Windows side). Training artifacts NEVER touch the Windows-side Symphony install.

Total WSL disk footprint at peak: ~15 GB (venv ~3 GB + positives ~2 GB + negatives ~5 GB + checkpoints ~2 GB + scratch ~3 GB). All under `~/.symphony-train/`, cleanly removable.

## Cleanup after success

```bash
# Inside WSL — keeps the venv for future retrains, removes raw data:
rm -rf ~/.symphony-train/positives ~/.symphony-train/positives-aug ~/.symphony-train/negatives
# Total recovered: ~12 GB
```

To fully purge the training env (e.g. before a clean retrain):
```bash
rm -rf ~/.symphony-train
```

## Licensing

The trained `hey-symphony.onnx` is **Apache-2.0-equivalent**. The openWakeWord pre-trained models (`hey_jarvis`, `alexa`, etc.) ship under CC BY-NC-SA 4.0, but **only those pretrained-by-upstream weights** carry that license. When you train from scratch using:

- Apache-2.0 openWakeWord backbone (the embedding model + classifier architecture)
- Symphony-generated synthetic TTS data (piper voices are also permissively licensed)
- Pre-embedded HuggingFace negative features (Apache-2.0 dataset)

…the resulting model is **yours**, with no CC BY-NC-SA encumbrance. The repo's `assets/wake-models/LICENSE.md` documents this.

## Failure modes

| Symptom | Fix |
|---|---|
| `nvidia-smi` fails inside WSL | `wsl --shutdown` then retry. If persists: update NVIDIA driver on Windows side (≥530.x for WSL GPU). |
| `pip install openwakeword[training]` fails on torch | Manual: `pip install torch --index-url https://download.pytorch.org/whl/cu121` first. |
| Piper sample-generator fails on a voice | The `--voice <name>` flag is fragile — fall back to `en_US-lessac-medium` only. |
| Training OOMs at batch 25 | Edit `train.py` → `BATCH_SIZE = 10` (4060 8 GB should handle 25; reduce if you see OOM). |
| ONNX export errors at "tflite step" | The TFLite-export step in upstream training notebooks fails harmlessly after ONNX is saved. Check `~/.symphony-train/output/hey-symphony.onnx` exists; if so, ignore the TFLite error. |
| `lgpearson1771/openwakeword-trainer` git pull fails | Falls back to upstream `dscripka/openWakeWord` notebooks (see `train.py` comments). |

## Retraining with real recordings (deferred — 6C.5 follow-up)

If the synthetic-only model's FRR is too high in real-world use:

1. Record 50–100 varied "Hey Symphony" samples on your hardware (`arecord -f S16_LE -r 16000 -c 1 ~/.symphony-train/positives-real/sample_001.wav` from WSL; or any mic recording app, then convert to 16 kHz mono PCM WAV).
2. Vary: volume (whisper/normal/loud), speed (slow/normal/fast), position (close mic / far / side), mood (calm/excited/tired). Same word every time is fine — varied prosody is what matters.
3. Re-run from step 3 (augment-positives.py — it auto-picks up `positives-real/` if present and weights them 3× in training loss).
4. Commit the new `.onnx`. Worktree-clean; non-destructive.
