# Training `hey-symphony.onnx`

Operational runbook for producing `assets/wake-models/hey-symphony.onnx`. **One-time** op per model revision — the resulting `.onnx` ships with Symphony, so end-users never run this.

openWakeWord's trainer is an **integrated command** (`python -m openwakeword.train --training_config <yaml> --generate_clips --augment_clips --train_model`). It clones Piper for synthetic TTS, mixes RIR + background noise, and trains an FCN head against ~2000 hrs of pre-computed negative features. We do NOT reimplement any of that — `training_config.yml` is the only Symphony-specific artifact.

The resulting model is **Apache-2.0** (self-trained on the Apache-2.0 backbone + permissive data — NOT derived from the CC BY-NC-SA bundled models). See `assets/wake-models/LICENSE.md`.

---

## Two paths

| | Colab (recommended) | Local WSL GPU |
|---|---|---|
| Setup | Zero — browser only | `setup-wsl.sh` + `download-data.sh` |
| GPU | Free T4 (cloud) | Your RTX 4060 |
| Python | 3.10 (Colab default — all upstream pins work) | 3.11 via deadsnakes (3.12 breaks the pins) |
| Time | ~15 min | ~1–2 hrs (incl. ~4 GB download + deps) |
| Risk | Low — the notebook is the upstream-maintained path | Medium — dependency-version friction on WSL |

**Why Colab is recommended:** openWakeWord's training stack pins `tensorflow-cpu==2.8.1`, `speechbrain==0.5.14`, etc. — all targeting Python 3.10/Colab. On WSL Python 3.12 they fail to build. The local path works around this with a 3.11 venv + skipping the TFLite-export deps, but it's more moving parts. The trained `.onnx` is identical either way — it's a one-time artifact, so the fastest reliable path wins.

---

## Path A — Google Colab (recommended)

1. Open the official notebook: <https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb> → "Open in Colab".
2. Runtime → Change runtime type → **T4 GPU**.
3. Run the environment-setup + data-download cells as-is (cells 1–10).
4. In the **config cell** (the one with `config["target_phrase"] = [...]`), set:
   ```python
   config["target_phrase"] = ["hey symphony"]
   config["model_name"] = "hey-symphony"
   config["n_samples"] = 10000          # bump to 50000+ for production accuracy
   config["n_samples_val"] = 2000
   config["steps"] = 50000
   config["target_false_positives_per_hour"] = 0.2
   config["max_negative_weight"] = 1500
   ```
   (These mirror `training_config.yml` in this dir — keep them in sync.)
5. Run the training cells. ~10–15 min on T4.
6. Download `my_custom_model/hey-symphony.onnx` (the notebook's output dir) to your machine, e.g. `~/Downloads/hey-symphony.onnx`.
7. From WSL, commit it into the repo:
   ```bash
   wsl -d Ubuntu
   cd /mnt/c/Users/chris/projects/symphony/scripts/train-wake-word
   bash export-and-commit.sh /mnt/c/Users/chris/Downloads/hey-symphony.onnx
   ```
8. From PowerShell:
   ```powershell
   git add assets/wake-models/
   git commit -m "feat(voice): hey-symphony.onnx — trained model"
   git push
   ```

## Path B — Local WSL GPU

Prereqs: WSL2 + Ubuntu, GPU visible inside WSL (`wsl -d Ubuntu --exec /usr/lib/wsl/lib/nvidia-smi` shows your card; if it fails with `NVML init`, run `wsl --shutdown` from PowerShell — that restarts only the WSL VM, NOT Windows). ~15 GB free disk on the WSL side.

```bash
wsl -d Ubuntu
cd /mnt/c/Users/chris/projects/symphony/scripts/train-wake-word

# 1. Environment: 3.11 venv + git clones + deps + embedding backbone (~10 min)
bash setup-wsl.sh

# 2. Datasets: MIT RIRs + AudioSet slice + ~2 GB negative features (~10 min)
bash download-data.sh

# 3. Train: generate → augment → train. ~1-2 hrs on RTX 4060.
bash train.sh

# 4. Export into the repo.
bash export-and-commit.sh
exit
```

```powershell
# From PowerShell:
git add assets/wake-models/
git commit -m "feat(voice): hey-symphony.onnx — trained model"
git push
```

---

## After committing the model

The model lands at `assets/wake-models/hey-symphony.onnx`. Verify the full pipeline:

```powershell
pnpm build                                       # tsup copies it into dist/assets/wake-models/
node dist/index.js voice diagnose --wake-word --json   # PASS if ≥1 wake_word fires on the fixture
node dist/index.js voice listen --threshold 0.6        # live mic — say "Hey Symphony" 5x
```

The Phase 6C integration + scenario tests (`tests/integration/6c-wake-word`, `tests/scenarios/6c`) skip-gracefully until the model exists, then activate automatically.

---

## Cleanup after success

```bash
# WSL side — keep the venv for future retrains, drop the bulky data:
rm -rf ~/.symphony-train/work/audioset* ~/.symphony-train/work/mit_rirs \
       ~/.symphony-train/work/*.npy ~/.symphony-train/work/hey-symphony-out/clips
# Full purge before a clean retrain:
# rm -rf ~/.symphony-train
```

---

## Failure modes

| Symptom | Fix |
|---|---|
| `nvidia-smi` fails inside WSL | `wsl --shutdown` from PowerShell, retry. NOT a full Windows reboot. |
| `tensorflow` / `onnx_tf` install fails on WSL | Expected on 3.12 — that's why `setup-wsl.sh` uses 3.11 + skips those deps. The `.onnx` is written before the TFLite step. |
| `train.sh` reports exit ≠ 0 but `.onnx` exists | The optional `.tflite` export failed (no tensorflow). The `.onnx` is valid; proceed. `train.sh` already detects + tolerates this. |
| Piper generation fails / hangs | Confirm `piper-sample-generator/models/en_US-libritts_r-medium.pt` downloaded (~60 MB). Re-run `setup-wsl.sh` (idempotent). |
| HF download stalls | Set `HF_HUB_ENABLE_HF_TRANSFER=1` for faster pulls, or retry — `download-data.sh` skips already-downloaded files. |

## Retraining with real recordings (FRR improvement — deferred)

If the synthetic-only model misses your voice too often:

1. Record 50–100 varied "Hey Symphony" clips (16 kHz mono WAV). Vary volume/speed/position/mood — same word is fine, varied prosody is what matters.
2. Colab notebook: drop them into the positive clips dir + bump their loss weight (the notebook documents a `positive` weight knob). Local: place under `~/.symphony-train/work/hey-symphony-out/positive_features/` per the openWakeWord docs.
3. Retrain + re-export. Non-destructive — same commands, better model.
